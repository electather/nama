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
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackRuntimeService
{
  private const int MaximumIdentifierLength = 256;
  private const int MaximumOperationLength = 256;
  private const int MaximumApiKeyLength = 4096;
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly ILibraryManager _libraryManager;
  private readonly IMediaSourceManager _mediaSourceManager;
  private readonly PlaybackNegotiationService _negotiation;
  private readonly ISessionManager _sessionManager;
  private readonly PlaybackSessionStore _sessions;
  private readonly PlaybackTokenService _tokens;
  private readonly IUserManager _userManager;

  public PlaybackRuntimeService(
      ExtensionHostCompatibility compatibility,
      ILibraryManager libraryManager,
      PlaybackNegotiationService negotiation,
      IMediaSourceManager mediaSourceManager,
      ISessionManager sessionManager,
      PlaybackSessionStore sessions,
      PlaybackTokenService tokens,
      IUserManager userManager)
  {
    _compatibility = compatibility;
    _libraryManager = libraryManager;
    _negotiation = negotiation;
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
    var plan = CreatePlan(input, itemId, sourceId, userId, source);
    return Task.FromResult(plan);
  }

  public async Task<OpenPlaybackOutput> OpenAsync(
      JsonElement body,
      StringValues authorizationHeaders,
      CancellationToken cancellationToken)
  {
    RequireCompatibleHost();
    var input = Deserialize<OpenPlaybackInput>(body);
    var operationId = RequiredText(input.OperationId, MaximumOperationLength);
    var planId = RequiredText(input.PlanId, MaximumIdentifierLength);
    if (input.SubtitleDisabled == input.SubtitleTrackIndex.HasValue)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    var openRequest = new PlaybackOpenRequest(
        operationId,
        planId,
        input.AudioTrackIndex,
        input.SubtitleDisabled,
        input.SubtitleTrackIndex);
    var apiKey = ApiKeyFrom(authorizationHeaders);
    var state = await _sessions.OpenAsync(
        openRequest,
        () =>
        {
          var planNonce = _tokens.UnprotectPlan(openRequest.PlanId, out _);
          return _sessions.GetPlan(planNonce);
        },
        async plan => await CreateSessionAsync(plan, openRequest, apiKey).ConfigureAwait(false),
        cancellationToken).ConfigureAwait(false);
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
    var selectedAudioTrackIndex =
        input.SelectedAudioTrackIndex ?? state.Output.SelectedAudioTrackIndex;
    var selectedSubtitleTrackIndex =
        input.SelectedSubtitleTrackIndex ?? state.Output.SelectedSubtitleTrackIndex;
    if (selectedAudioTrackIndex != state.Output.SelectedAudioTrackIndex
        || selectedSubtitleTrackIndex != state.Output.SelectedSubtitleTrackIndex)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var reportSignature = string.Create(
        CultureInfo.InvariantCulture,
        $"{sequence}\n{input.State}\n{positionTicks}\n{selectedAudioTrackIndex}\n{selectedSubtitleTrackIndex?.ToString(CultureInfo.InvariantCulture) ?? "-"}");
    await _sessions.ReportAsync(
        state.Output.SessionId,
        eventId,
        reportSignature,
        sequence,
        current => WriteReportAsync(current, input.State, positionTicks),
        cancellationToken).ConfigureAwait(false);
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
    await _sessions.CloseAsync(
        state.Output.SessionId,
        operationId,
        closeSignature,
        async current =>
        {
          if (current.PlaybackStarted)
          {
            await _sessionManager.OnPlaybackStopped(new PlaybackStopInfo
            {
              Failed = input.Reason is "failed" or "cancelled",
              ItemId = current.Plan.ItemId,
              MediaSourceId = current.Plan.SourceId,
              PlaySessionId = current.Output.SessionId,
              PositionTicks = positionTicks,
              SessionId = current.JellyfinSessionId
            }).ConfigureAwait(false);
          }
        },
        cancellationToken).ConfigureAwait(false);
  }

  private PlanPlaybackOutput CreatePlan(
      PlanPlaybackInput input,
      Guid itemId,
      string sourceId,
      Guid userId,
      MediaSourceInfo source)
  {
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
    var runtime = TimeSpan.FromTicks(source.RunTimeTicks.Value);
    if (runtime + PlaybackConstants.SessionGrace > PlaybackConstants.MaximumSessionLifetime)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "RUNTIME_UNSUPPORTED");
    }
    var startPosition = input.StartPosition is null
        ? 0
        : DurationTicks(input.StartPosition, source.RunTimeTicks.Value);
    var initialNegotiation = _negotiation.Negotiate(input, itemId, source);
    var tracks = MaterializableTracks(
        input,
        itemId,
        source,
        initialNegotiation,
        PlaybackNegotiationService.Tracks(source));
    var trackIndexes = tracks.Select(track => track.Index).ToHashSet();
    var videoTrackIndex = source.VideoStream?.Index;
    var negotiation = initialNegotiation with
    {
      Actions = initialNegotiation.Actions
          .Where(action =>
              trackIndexes.Contains(action.TrackIndex)
              || action.TrackIndex == videoTrackIndex)
          .ToArray()
    };
    var plan = new PlaybackPlan(
        PlaybackTokenService.CreateOpaqueId(),
        itemId,
        sourceId,
        userId,
        source.RunTimeTicks.Value,
        startPosition,
        input,
        negotiation,
        tracks);
    var expiresAt = DateTimeOffset.UtcNow + PlaybackConstants.PlanLifetime;
    var planId = _tokens.ProtectPlan(plan.Nonce, expiresAt);
    _sessions.StorePlan(plan, expiresAt);
    return new PlanPlaybackOutput(
        planId,
        expiresAt,
        negotiation.Strategy,
        negotiation.Container,
        negotiation.VideoCodec,
        negotiation.AudioCodec,
        negotiation.Protocol,
        tracks,
        negotiation.AudioTrackIndex,
        negotiation.SubtitleTrackIndex,
        negotiation.Actions);
  }

  private async Task<PlaybackSessionState> CreateSessionAsync(
      PlaybackPlan plan,
      PlaybackOpenRequest openRequest,
      string apiKey)
  {
    var user = _userManager.GetUserById(plan.UserId)
        ?? throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    var item = _libraryManager.GetItemById<BaseItem>(plan.ItemId, user);
    if (item is not Movie && item is not Episode)
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }
    var source = _mediaSourceManager
        .GetStaticMediaSources(item, enablePathSubstitution: false, user)
        .SingleOrDefault(candidate => string.Equals(
            candidate.Id,
            plan.SourceId,
            StringComparison.Ordinal))
        ?? throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    var selectedAudioTrackIndex =
        openRequest.AudioTrackIndex ?? plan.Negotiation.AudioTrackIndex;
    var negotiation = _negotiation.Negotiate(
        plan.Input,
        plan.ItemId,
        source,
        selectedAudioTrackIndex,
        openRequest.SubtitleTrackIndex,
        openRequest.SubtitleDisabled);
    if (!EquivalentPlan(plan.Negotiation, negotiation))
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "TRACK_SELECTION_REQUIRES_REPLAN");
    }

    var sessionId = PlaybackTokenService.CreateOpaqueId();
    negotiation.Stream.PlaySessionId = sessionId;
    negotiation.Stream.StartPositionTicks = plan.StartPositionTicks;
    var stockTarget = RequiredStockTarget(negotiation.Stream.ToUrl(null, null, null));
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
            plan.ItemId,
            plan.SourceId,
            apiKey),
        expiresAt);
    var mediaResource = _tokens.ProtectMediaResource(
        new MediaResourcePayload(
            sessionId,
            stockTarget,
            string.Equals(negotiation.Protocol, "hls", StringComparison.Ordinal)),
        expiresAt);
    var sessionContext = _tokens.ProtectSessionContext(
        new SessionContextPayload(sessionId),
        expiresAt);
    var externalSubtitles = ExternalSubtitles(plan, negotiation, sessionId, expiresAt);
    var output = new OpenPlaybackOutput(
        sessionId,
        plan.ItemId.ToString("N", CultureInfo.InvariantCulture),
        plan.SourceId,
        mediaResource,
        mediaLease,
        negotiation.Protocol,
        negotiation.MimeType,
        expiresAt,
        PlaybackConstants.ReportIntervalSeconds,
        plan.Tracks.Select(track => new SessionTrackModel(track.Index, false)).ToArray(),
        negotiation.AudioTrackIndex,
        negotiation.SubtitleTrackIndex,
        externalSubtitles,
        sessionContext);
    return new PlaybackSessionState(
        plan,
        openRequest,
        jellyfinSession.Id,
        expiresAt,
        output);
  }

  private PlaybackTrackModel[] MaterializableTracks(
      PlanPlaybackInput input,
      Guid itemId,
      MediaSourceInfo source,
      NegotiatedPlayback planned,
      IReadOnlyList<PlaybackTrackModel> tracks)
  {
    return tracks.Where(track => track.Type switch
    {
      "audio" => CanMaterialize(
          input,
          itemId,
          source,
          planned,
          track.Index,
          planned.SubtitleTrackIndex,
          !planned.SubtitleTrackIndex.HasValue),
      "subtitle" => CanMaterialize(
          input,
          itemId,
          source,
          planned,
          planned.AudioTrackIndex,
          track.Index,
          false),
      "video" => true,
      _ => false
    }).ToArray();
  }

  private bool CanMaterialize(
      PlanPlaybackInput input,
      Guid itemId,
      MediaSourceInfo source,
      NegotiatedPlayback planned,
      int audioTrackIndex,
      int? subtitleTrackIndex,
      bool subtitleDisabled)
  {
    try
    {
      return EquivalentPlan(
          planned,
          _negotiation.Negotiate(
              input,
              itemId,
              source,
              audioTrackIndex,
              subtitleTrackIndex,
              subtitleDisabled));
    }
    catch (PlaybackRequestException)
    {
      return false;
    }
  }

  private IReadOnlyList<ExternalSubtitleModel> ExternalSubtitles(
      PlaybackPlan plan,
      NegotiatedPlayback negotiation,
      string sessionId,
      DateTimeOffset expiresAt)
  {
    if (negotiation.SubtitleTrackIndex is not int subtitleIndex
        || !string.Equals(negotiation.SubtitleAction, "external", StringComparison.Ordinal))
    {
      return [];
    }
    var subtitle = plan.Tracks.Single(track =>
        string.Equals(track.Type, "subtitle", StringComparison.Ordinal)
        && track.Index == subtitleIndex);
    var stockTarget = negotiation.Stream.SubtitleDeliveryMethod
        == MediaBrowser.Model.Dlna.SubtitleDeliveryMethod.Hls
        ? $"/Videos/{plan.ItemId.ToString("N", CultureInfo.InvariantCulture)}/{Uri.EscapeDataString(plan.SourceId)}/Subtitles/{subtitleIndex.ToString(CultureInfo.InvariantCulture)}/subtitles.m3u8?segmentLength=2"
        : $"/Videos/{plan.ItemId.ToString("N", CultureInfo.InvariantCulture)}/{Uri.EscapeDataString(plan.SourceId)}/Subtitles/{subtitleIndex.ToString(CultureInfo.InvariantCulture)}/0/Stream.{Uri.EscapeDataString(negotiation.Stream.SubtitleFormat ?? subtitle.Codec)}";
    var rewritePlaylist = negotiation.Stream.SubtitleDeliveryMethod
        == MediaBrowser.Model.Dlna.SubtitleDeliveryMethod.Hls;
    var mediaResource = _tokens.ProtectMediaResource(
        new MediaResourcePayload(sessionId, RequiredStockTarget(stockTarget), rewritePlaylist),
        expiresAt);
    return
    [
      new ExternalSubtitleModel(
          subtitleIndex,
          mediaResource,
          rewritePlaylist ? "application/vnd.apple.mpegurl" : SubtitleMimeType(subtitle.Codec))
    ];
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
        AudioStreamIndex = state.Output.SelectedAudioTrackIndex,
        CanSeek = true,
        IsPaused = string.Equals(playbackState, "paused", StringComparison.Ordinal),
        ItemId = state.Plan.ItemId,
        MediaSourceId = state.Plan.SourceId,
        PlayMethod = PlayMethodFrom(state.Plan.Negotiation.Strategy),
        SubtitleStreamIndex = state.Output.SelectedSubtitleTrackIndex,
        PlaySessionId = state.Output.SessionId,
        PositionTicks = positionTicks,
        SessionId = state.JellyfinSessionId
      }).ConfigureAwait(false);
      return;
    }

    await _sessionManager.OnPlaybackProgress(new PlaybackProgressInfo
    {
      AudioStreamIndex = state.Output.SelectedAudioTrackIndex,
      CanSeek = true,
      IsPaused = string.Equals(playbackState, "paused", StringComparison.Ordinal),
      ItemId = state.Plan.ItemId,
      MediaSourceId = state.Plan.SourceId,
      PlayMethod = PlayMethodFrom(state.Plan.Negotiation.Strategy),
      SubtitleStreamIndex = state.Output.SelectedSubtitleTrackIndex,
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

  private static bool EquivalentPlan(
      NegotiatedPlayback planned,
      NegotiatedPlayback selected)
  {
    return string.Equals(planned.Strategy, selected.Strategy, StringComparison.Ordinal)
        && string.Equals(planned.Container, selected.Container, StringComparison.Ordinal)
        && string.Equals(planned.VideoCodec, selected.VideoCodec, StringComparison.Ordinal)
        && string.Equals(planned.AudioCodec, selected.AudioCodec, StringComparison.Ordinal)
        && string.Equals(planned.Protocol, selected.Protocol, StringComparison.Ordinal);
  }

  private static string RequiredStockTarget(string value)
  {
    var queryIndex = value.IndexOf('?', StringComparison.Ordinal);
    var path = queryIndex < 0 ? value : value[..queryIndex];
    var query = queryIndex < 0 ? string.Empty : value[queryIndex..];
    if (value.Length is 0 or > 4096
        || value[0] != '/'
        || value.Contains("://", StringComparison.Ordinal)
        || path.Length == 0
        || QueryHelpers.ParseQuery(query).Any(pair =>
            PlaybackStockTarget.IsCredentialQueryName(pair.Key)))
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "STOCK_TARGET_UNSAFE");
    }
    return value;
  }

  private static string SubtitleMimeType(string codec)
  {
    return codec.ToLowerInvariant() switch
    {
      "srt" => "application/x-subrip",
      "vtt" or "webvtt" => "text/vtt",
      "ass" or "ssa" => "text/x-ssa",
      _ => "application/octet-stream"
    };
  }

  private static PlayMethod PlayMethodFrom(string strategy)
  {
    return strategy switch
    {
      "direct" => PlayMethod.DirectPlay,
      "remux" => PlayMethod.DirectStream,
      "transcode_audio" or "transcode_video" => PlayMethod.Transcode,
      _ => throw new InvalidOperationException("The stored playback strategy is invalid.")
    };
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
