using System.Globalization;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackRuntimeService
{
  private const int MaximumIdentifierLength = 256;
  private const int MaximumOperationLength = 256;
  private const int MaximumApiKeyLength = 4096;
  private const int AutoQuality = 1;
  private const string DirectContainer = "mp4";
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly ILibraryManager _libraryManager;
  private readonly IMediaSourceManager _mediaSourceManager;
  private readonly ISessionManager _sessionManager;
  private readonly PlaybackSessionStore _sessions;
  private readonly PlaybackTokenService _tokens;
  private readonly IUserManager _userManager;

  public PlaybackRuntimeService(
      ExtensionHostCompatibility compatibility,
      ILibraryManager libraryManager,
      IMediaSourceManager mediaSourceManager,
      ISessionManager sessionManager,
      PlaybackSessionStore sessions,
      PlaybackTokenService tokens,
      IUserManager userManager)
  {
    _compatibility = compatibility;
    _libraryManager = libraryManager;
    _mediaSourceManager = mediaSourceManager;
    _sessionManager = sessionManager;
    _sessions = sessions;
    _tokens = tokens;
    _userManager = userManager;
  }

  public Task<PlanPlaybackOutput> PlanAsync(JsonElement body, CancellationToken cancellationToken)
  {
    RequireCompatibleHost();
    var input = Deserialize<PlanPlaybackInput>(body);
    var itemId = RequiredGuid(input.ItemId);
    var userId = RequiredGuid(input.UserId);
    var sourceId = RequiredText(input.SourceId, MaximumIdentifierLength);
    var user = _userManager.GetUserById(userId)
        ?? throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
    if (item is not Movie && item is not Episode)
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }

    var source = _mediaSourceManager
        .GetStaticMediaSources(item, enablePathSubstitution: false, user)
        .SingleOrDefault(candidate => string.Equals(candidate.Id, sourceId, StringComparison.Ordinal));
    if (source is null)
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }

    cancellationToken.ThrowIfCancellationRequested();
    var plan = CreateDirectPlan(input, itemId, sourceId, userId, source);
    return Task.FromResult(plan);
  }

  public async Task<OpenPlaybackOutput> OpenAsync(
      JsonElement body,
      StringValues authorizationHeaders)
  {
    RequireCompatibleHost();
    var input = Deserialize<OpenPlaybackInput>(body);
    var operationId = RequiredText(input.OperationId, MaximumOperationLength);
    var planId = RequiredText(input.PlanId, MaximumIdentifierLength);
    var planNonce = _tokens.UnprotectPlan(planId, out _);
    var plan = _sessions.GetPlan(planNonce);
    if (input.AudioTrackIndex != plan.DefaultAudioTrackIndex || input.SubtitleTrackIndex is not null)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var apiKey = ApiKeyFrom(authorizationHeaders);
    var openSignature = string.Create(
        CultureInfo.InvariantCulture,
        $"{operationId}\n{plan.DefaultAudioTrackIndex}\n-");
    var state = await _sessions.OpenAsync(
        plan,
        openSignature,
        async () => await CreateSessionAsync(plan, apiKey, openSignature).ConfigureAwait(false))
        .ConfigureAwait(false);
    return state.Output;
  }

  public async Task ReportAsync(
      string sessionId,
      JsonElement body,
      CancellationToken cancellationToken)
  {
    RequireCompatibleHost();
    var input = Deserialize<ReportPlaybackInput>(body);
    var state = SessionFrom(sessionId, input.SessionContext);
    var eventId = RequiredText(input.EventId, MaximumOperationLength);
    if (!ulong.TryParse(input.Sequence, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence)
        || sequence == 0)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var positionTicks = DurationTicks(input.Position, state.Plan.RuntimeTicks);
    ValidateDuration(input.Duration, state.Plan.RuntimeTicks);
    if (input.SelectedAudioTrackIndex != state.Plan.DefaultAudioTrackIndex
        || input.SelectedSubtitleTrackIndex is not null)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var reportSignature = string.Create(
        CultureInfo.InvariantCulture,
        $"{sequence}\n{input.State}\n{positionTicks}\n{input.SelectedAudioTrackIndex}\n-");
    await state.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      if (state.Closed)
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      if (state.AcceptedEvents.TryGetValue(eventId, out var acceptedSignature))
      {
        if (!string.Equals(acceptedSignature, reportSignature, StringComparison.Ordinal))
        {
          throw new PlaybackRequestException(StatusCodes.Status409Conflict);
        }

        return;
      }

      if (sequence <= state.HighestSequence)
      {
        state.AcceptedEvents.Add(eventId, reportSignature);
        return;
      }

      await WriteReportAsync(state, input.State, positionTicks).ConfigureAwait(false);
      state.PlaybackStarted = true;
      state.HighestSequence = sequence;
      state.AcceptedEvents.Add(eventId, reportSignature);
    }
    finally
    {
      state.Gate.Release();
    }
  }

  public async Task CloseAsync(
      string sessionId,
      JsonElement body,
      CancellationToken cancellationToken)
  {
    RequireCompatibleHost();
    var input = Deserialize<ClosePlaybackInput>(body);
    var state = SessionFrom(sessionId, input.SessionContext);
    var operationId = RequiredText(input.OperationId, MaximumOperationLength);
    var positionTicks = DurationTicks(input.FinalPosition, state.Plan.RuntimeTicks);
    ValidateDuration(input.Duration, state.Plan.RuntimeTicks);
    if (input.Reason is not ("stopped" or "completed" or "failed" or "cancelled"))
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var closeSignature = string.Create(
        CultureInfo.InvariantCulture,
        $"{input.Reason}\n{positionTicks}");
    await state.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      if (state.Closed)
      {
        if (string.Equals(state.CloseOperationId, operationId, StringComparison.Ordinal)
            && string.Equals(state.CloseSignature, closeSignature, StringComparison.Ordinal))
        {
          return;
        }

        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      if (state.PlaybackStarted)
      {
        await _sessionManager.OnPlaybackStopped(new PlaybackStopInfo
        {
          Failed = input.Reason is "failed" or "cancelled",
          ItemId = state.Plan.ItemId,
          MediaSourceId = state.Plan.SourceId,
          PlaySessionId = state.Output.SessionId,
          PositionTicks = positionTicks,
          SessionId = state.JellyfinSessionId
        }).ConfigureAwait(false);
      }

      state.Closed = true;
      state.CloseOperationId = operationId;
      state.CloseSignature = closeSignature;
    }
    finally
    {
      state.Gate.Release();
    }
  }

  private PlanPlaybackOutput CreateDirectPlan(
      PlanPlaybackInput input,
      Guid itemId,
      string sourceId,
      Guid userId,
      MediaSourceInfo source)
  {
    if (!source.SupportsDirectPlay)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "DIRECT_PLAY_NOT_SUPPORTED");
    }
    if (source.RequiresOpening || source.RequiresClosing)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "SOURCE_REQUIRES_OPEN_OR_CLOSE");
    }
    if (source.Protocol != MediaProtocol.File)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "SOURCE_PROTOCOL_UNSUPPORTED");
    }
    if (source.RunTimeTicks is not > 0)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "SOURCE_RUNTIME_MISSING");
    }
    if (!ProviderContainerIncludes(source.Container, DirectContainer))
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "CONTAINER_UNSUPPORTED");
    }
    if (input.Preferences?.Quality != AutoQuality || input.Preferences.MaxBitRateBps is not null)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "PREFERENCES_UNSUPPORTED");
    }
    if (input.Capabilities?.Protocols?.Contains("http_progressive", StringComparer.Ordinal) != true)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "PROTOCOL_UNSUPPORTED");
    }

    var runtime = TimeSpan.FromTicks(source.RunTimeTicks.Value);
    if (runtime + PlaybackConstants.SessionGrace > PlaybackConstants.MaximumSessionLifetime)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "RUNTIME_UNSUPPORTED");
    }

    var videoStreams = source.MediaStreams.Where(stream => stream.Type == MediaStreamType.Video).ToArray();
    var audioStreams = source.MediaStreams.Where(stream => stream.Type == MediaStreamType.Audio).ToArray();
    var subtitleStreams = source.MediaStreams.Where(stream => stream.Type == MediaStreamType.Subtitle).ToArray();
    if (videoStreams.Length != 1 || audioStreams.Length == 0 || subtitleStreams.Length != 0)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "STREAMS_UNSUPPORTED");
    }

    var videoCodec = RequiredProviderText(videoStreams[0].Codec);
    var defaultAudio = audioStreams.FirstOrDefault(
        stream => stream.Index == source.DefaultAudioStreamIndex)
        ?? audioStreams.FirstOrDefault(stream => stream.IsDefault)
        ?? audioStreams[0];
    var audioCodec = RequiredProviderText(defaultAudio.Codec);
    if (!SupportsDirectProfile(input.Capabilities?.DirectPlayProfiles, DirectContainer, videoCodec, audioCodec))
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "PROFILE_UNSUPPORTED");
    }

    var startPosition = DurationTicks(input.StartPosition, source.RunTimeTicks.Value);
    if (startPosition > source.RunTimeTicks.Value)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var tracks = new[]
    {
      new PlaybackTrackModel(
          defaultAudio.Index,
          "audio",
          audioCodec,
          defaultAudio.Channels,
          true,
          defaultAudio.IsForced,
          BoundedProviderText(defaultAudio.Title),
          BoundedProviderText(defaultAudio.Language)),
    };
    var plan = new PlaybackPlan(
        PlaybackTokenService.CreateOpaqueId(),
        itemId,
        sourceId,
        userId,
        source.RunTimeTicks.Value,
        DirectContainer,
        videoCodec,
        audioCodec,
        defaultAudio.Index,
        tracks);
    var expiresAt = DateTimeOffset.UtcNow + PlaybackConstants.PlanLifetime;
    var planId = _tokens.ProtectPlan(plan.Nonce, expiresAt);
    _sessions.StorePlan(plan, expiresAt);
    return new PlanPlaybackOutput(
        planId,
        expiresAt,
        "direct",
        plan.Container,
        videoCodec,
        audioCodec,
        "http_progressive",
        tracks,
        defaultAudio.Index,
        null,
        tracks.Select(track => new PlaybackActionModel(track.Index, "copy")).ToArray());
  }

  private async Task<PlaybackSessionState> CreateSessionAsync(
      PlaybackPlan plan,
      string apiKey,
      string openSignature)
  {
    var user = _userManager.GetUserById(plan.UserId)
        ?? throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    var sessionId = PlaybackTokenService.CreateOpaqueId();
    var mediaResource = PlaybackTokenService.CreateOpaqueId();
    var expiresAt = DateTimeOffset.UtcNow
        + TimeSpan.FromTicks(plan.RuntimeTicks)
        + PlaybackConstants.SessionGrace;
    var jellyfinSession = await _sessionManager.LogSessionActivity(
        "Nama",
        "1.0.0",
        sessionId,
        "Nama Playback",
        "127.0.0.1",
        user).ConfigureAwait(false);
    var mediaLease = _tokens.ProtectMediaLease(
        new MediaLeasePayload(
            sessionId,
            mediaResource,
            plan.ItemId,
            plan.SourceId,
            plan.Container,
            apiKey),
        expiresAt);
    var sessionContext = _tokens.ProtectSessionContext(
        new SessionContextPayload(sessionId),
        expiresAt);
    var output = new OpenPlaybackOutput(
        sessionId,
        plan.ItemId.ToString("N", CultureInfo.InvariantCulture),
        plan.SourceId,
        mediaResource,
        mediaLease,
        "video/mp4",
        expiresAt,
        PlaybackConstants.ReportIntervalSeconds,
        plan.Tracks.Select(track => new SessionTrackModel(track.Index, false)).ToArray(),
        plan.DefaultAudioTrackIndex,
        null,
        sessionContext);
    return new PlaybackSessionState(
        plan,
        openSignature,
        jellyfinSession.Id,
        expiresAt,
        output);
  }

  private async Task WriteReportAsync(
      PlaybackSessionState state,
      string? playbackState,
      long positionTicks)
  {
    if (playbackState is not ("playing" or "paused" or "buffering"))
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    if (!state.PlaybackStarted)
    {
      await _sessionManager.OnPlaybackStart(new PlaybackStartInfo
      {
        AudioStreamIndex = state.Plan.DefaultAudioTrackIndex,
        CanSeek = true,
        IsPaused = playbackState == "paused",
        ItemId = state.Plan.ItemId,
        MediaSourceId = state.Plan.SourceId,
        PlayMethod = PlayMethod.DirectPlay,
        PlaySessionId = state.Output.SessionId,
        PositionTicks = positionTicks,
        SessionId = state.JellyfinSessionId
      }).ConfigureAwait(false);
      return;
    }

    await _sessionManager.OnPlaybackProgress(new PlaybackProgressInfo
    {
      AudioStreamIndex = state.Plan.DefaultAudioTrackIndex,
      CanSeek = true,
      IsPaused = playbackState == "paused",
      ItemId = state.Plan.ItemId,
      MediaSourceId = state.Plan.SourceId,
      PlayMethod = PlayMethod.DirectPlay,
      PlaySessionId = state.Output.SessionId,
      PositionTicks = positionTicks,
      SessionId = state.JellyfinSessionId
    }).ConfigureAwait(false);
  }

  private PlaybackSessionState SessionFrom(string sessionId, string? sessionContext)
  {
    var boundedSessionId = RequiredText(sessionId, MaximumIdentifierLength);
    var context = _tokens.UnprotectSessionContext(RequiredText(sessionContext, 8192));
    if (!string.Equals(context.SessionId, boundedSessionId, StringComparison.Ordinal))
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }

    return _sessions.Get(boundedSessionId);
  }

  private void RequireCompatibleHost()
  {
    if (!_compatibility.IsCompatible)
    {
      throw new PlaybackRequestException(StatusCodes.Status503ServiceUnavailable);
    }
  }

  private static T Deserialize<T>(JsonElement body)
  {
    try
    {
      return body.Deserialize<T>()
          ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    catch (JsonException)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static Guid RequiredGuid(string? value)
  {
    if (!Guid.TryParse(value, out var parsed))
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    return parsed;
  }

  private static string RequiredText(string? value, int maximumLength)
  {
    if (string.IsNullOrEmpty(value) || value.Length > maximumLength)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    return value;
  }

  private static string RequiredProviderText(string? value)
  {
    if (string.IsNullOrEmpty(value) || value.Length > MaximumIdentifierLength)
    {
      throw new PlaybackRequestException(StatusCodes.Status412PreconditionFailed);
    }

    return value.ToLowerInvariant();
  }

  private static string? BoundedProviderText(string? value)
  {
    return string.IsNullOrEmpty(value) || value.Length > MaximumIdentifierLength
        ? null
        : value;
  }

  private static bool ProviderContainerIncludes(string? providerContainers, string expected)
  {
    return providerContainers?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Contains(expected, StringComparer.OrdinalIgnoreCase) == true;
  }

  private static bool SupportsDirectProfile(
      IReadOnlyList<DirectPlayProfileInput>? profiles,
      string container,
      string videoCodec,
      string audioCodec)
  {
    return profiles is { Count: > 0 and <= 100 }
        && profiles.Any(profile =>
            string.Equals(profile.Container, container, StringComparison.OrdinalIgnoreCase)
            && string.Equals(profile.VideoCodec, videoCodec, StringComparison.OrdinalIgnoreCase)
            && profile.AudioCodecs?.Contains(audioCodec, StringComparer.OrdinalIgnoreCase) == true);
  }

  private static long DurationTicks(DurationInput? input, long maximumTicks)
  {
    if (input is null
        || !long.TryParse(input.Seconds, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
        || seconds < 0
        || input.Nanos is < 0 or >= 1_000_000_000)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    try
    {
      var ticks = checked((seconds * PlaybackConstants.JellyfinTicksPerSecond) + (input.Nanos / 100));
      if (ticks > maximumTicks)
      {
        throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
      }

      return ticks;
    }
    catch (OverflowException)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static void ValidateDuration(DurationInput? input, long expectedTicks)
  {
    if (input is not null && DurationTicks(input, expectedTicks) != expectedTicks)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static string ApiKeyFrom(StringValues headers)
  {
    if (headers.Count != 1)
    {
      throw new PlaybackRequestException(StatusCodes.Status401Unauthorized);
    }

    const string prefix = "MediaBrowser Token=\"";
    var authorization = headers[0];
    if (authorization is null
        || !authorization.StartsWith(prefix, StringComparison.Ordinal)
        || !authorization.EndsWith('"')
        || authorization.Length <= prefix.Length + 1)
    {
      throw new PlaybackRequestException(StatusCodes.Status401Unauthorized);
    }

    var apiKey = authorization[prefix.Length..^1];
    if (apiKey.Length > MaximumApiKeyLength
        || apiKey.Contains('"', StringComparison.Ordinal)
        || apiKey.Contains('\\', StringComparison.Ordinal))
    {
      throw new PlaybackRequestException(StatusCodes.Status401Unauthorized);
    }

    return apiKey;
  }
}
