using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http;


namespace Nama.Jellyfin.Extension;

internal sealed record StoredPlaybackPlan(
    PlaybackPlan Plan,
    DateTimeOffset ExpiresAt);

internal sealed record PlaybackOpenRequest(
    string OperationId,
    string PlanId,
    int? AudioTrackIndex,
    bool SubtitleDisabled,
    int? SubtitleTrackIndex);

internal sealed record AmbiguousPlaybackOpen(
    PlaybackOpenRequest Request,
    int? SelectedAudioTrackIndex,
    string PlanNonce,
    DateTimeOffset ExpiresAt);

internal sealed class PlaybackSessionState
{
  public PlaybackSessionState(
      PlaybackPlan plan,
      PlaybackOpenRequest openRequest,
      string jellyfinSessionId,
      DateTimeOffset expiresAt,
      OpenPlaybackOutput output)
  {
    Plan = plan;
    OpenRequest = openRequest;
    JellyfinSessionId = jellyfinSessionId;
    ExpiresAt = expiresAt;
    Output = output;
    var lifetimeTicks = checked(plan.RuntimeTicks + PlaybackConstants.SessionGrace.Ticks);
    var reportIntervalTicks =
        TimeSpan.FromSeconds(PlaybackConstants.ReportIntervalSeconds).Ticks;
    var reportIntervalCount = lifetimeTicks / reportIntervalTicks;
    if (lifetimeTicks % reportIntervalTicks != 0)
    {
      reportIntervalCount++;
    }
    AcceptedEventCapacity = checked((int)Math.Min(8_192, reportIntervalCount + 2_048));
  }

  public SemaphoreSlim Gate { get; } = new(1, 1);

  public Dictionary<string, string> AcceptedEvents { get; } = new(StringComparer.Ordinal);
  public Dictionary<string, string> AmbiguousEvents { get; } = new(StringComparer.Ordinal);

  public int AcceptedEventCapacity { get; }

  public PlaybackPlan Plan { get; }

  public PlaybackOpenRequest OpenRequest { get; }

  public string JellyfinSessionId { get; }

  public DateTimeOffset ExpiresAt { get; }

  public OpenPlaybackOutput Output { get; }

  public ulong HighestSequence { get; set; }

  public bool PlaybackStarted { get; set; }

  public bool Closed { get; set; }
  public bool CloseAmbiguous { get; set; }

  public string? CloseOperationId { get; set; }

  public string? CloseSignature { get; set; }
}

internal sealed class PlaybackSessionStore
{
  private const int MaximumStoredPlans = 128;
  private const int MaximumStoredSessions = 16;
  private readonly SemaphoreSlim _openGate = new(1, 1);
  private readonly Lock _planGate = new();
  private readonly ConcurrentDictionary<string, StoredPlaybackPlan> _plansByNonce = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, AmbiguousPlaybackOpen> _ambiguousOpensByOperationId = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, string> _ambiguousOpenOperationByPlanId = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, string> _ambiguousOpenOperationByPlanNonce = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsById = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByPlanNonce = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByPlanId = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByOperationId = new(StringComparer.Ordinal);
  private readonly TimeProvider _timeProvider;

  public PlaybackSessionStore()
      : this(TimeProvider.System)
  {
  }

  internal PlaybackSessionStore(TimeProvider timeProvider)
  {
    ArgumentNullException.ThrowIfNull(timeProvider);
    _timeProvider = timeProvider;
  }
  public void StorePlan(PlaybackPlan plan, DateTimeOffset expiresAt)
  {
    lock (_planGate)
    {
      RemoveExpiredPlans(_timeProvider.GetUtcNow());
      if (_plansByNonce.ContainsKey(plan.Nonce))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
      if (_plansByNonce.Count >= MaximumStoredPlans)
      {
        throw new PlaybackRequestException(
            StatusCodes.Status429TooManyRequests,
            "PLAYBACK_PLAN_LIMIT_REACHED");
      }
      if (!_plansByNonce.TryAdd(plan.Nonce, new StoredPlaybackPlan(plan, expiresAt)))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
    }
  }

  public PlaybackPlan GetPlan(string planNonce)
  {
    if (
        _plansByNonce.TryGetValue(planNonce, out var stored)
        && stored.ExpiresAt > _timeProvider.GetUtcNow())
    {
      return stored.Plan;
    }

    _plansByNonce.TryRemove(planNonce, out _);
    throw new PlaybackRequestException(StatusCodes.Status404NotFound);
  }

  public async Task<PlaybackSessionState> OpenAsync(
      PlaybackOpenRequest request,
      Func<PlaybackPlan> resolveLivePlan,
      Func<PlaybackPlan, Task<PlaybackSessionState>> create,
      CancellationToken cancellationToken = default)
  {
    await _openGate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      await RemoveExpiredSessionsAsync(cancellationToken).ConfigureAwait(false);
      if (_ambiguousOpensByOperationId.TryGetValue(request.OperationId, out var ambiguousReplay))
      {
        RequireMatchingAmbiguousOpen(ambiguousReplay, request);
      }
      if (_sessionsByOperationId.TryGetValue(request.OperationId, out var replay))
      {
        return RequireMatchingReplay(replay, request);
      }
      if (_sessionsByPlanId.ContainsKey(request.PlanId))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
      if (_ambiguousOpenOperationByPlanId.ContainsKey(request.PlanId))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
      if (_sessionsById.Count + _ambiguousOpensByOperationId.Count >= MaximumStoredSessions)
      {
        throw new PlaybackRequestException(
            StatusCodes.Status429TooManyRequests,
            "PLAYBACK_SESSION_LIMIT_REACHED");
      }

      var plan = resolveLivePlan();
      RequireTrackMembership(plan, request.AudioTrackIndex, "audio");
      RequireTrackMembership(plan, request.SubtitleTrackIndex, "subtitle");
      if (_sessionsByPlanNonce.ContainsKey(plan.Nonce))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
      if (_ambiguousOpenOperationByPlanNonce.ContainsKey(plan.Nonce))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      cancellationToken.ThrowIfCancellationRequested();
      PlaybackSessionState created;
      try
      {
        created = await create(plan).ConfigureAwait(false);
      }
      catch (Exception exception) when (exception is not PlaybackRequestException)
      {
        RetainAmbiguousOpen(plan, request);
        throw AmbiguousMutation();
      }
      CommitOpenedSession(plan, request, created);
      return created;
    }
    finally
    {
      _openGate.Release();
    }
  }

  public PlaybackSessionState Get(string sessionId)
  {
    if (
        _sessionsById.TryGetValue(sessionId, out var session)
        && session.ExpiresAt > _timeProvider.GetUtcNow())
    {
      return session;
    }

    throw new PlaybackRequestException(StatusCodes.Status404NotFound);
  }

  public async Task ReportAsync(
      string sessionId,
      string eventId,
      string signature,
      ulong sequence,
      Func<PlaybackSessionState, Task> apply,
      CancellationToken cancellationToken)
  {
    var state = Get(sessionId);
    await state.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      RequireUnexpired(state);
      if (state.AcceptedEvents.TryGetValue(eventId, out var acceptedSignature))
      {
        if (!string.Equals(acceptedSignature, signature, StringComparison.Ordinal))
        {
          throw new PlaybackRequestException(StatusCodes.Status409Conflict);
        }

        return;
      }
      if (state.AmbiguousEvents.TryGetValue(eventId, out var ambiguousSignature))
      {
        if (!string.Equals(ambiguousSignature, signature, StringComparison.Ordinal))
        {
          throw new PlaybackRequestException(StatusCodes.Status409Conflict);
        }
        throw AmbiguousMutation();
      }
      if (state.Closed)
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }
      if (state.AcceptedEvents.Count + state.AmbiguousEvents.Count
          >= state.AcceptedEventCapacity)
      {
        throw new PlaybackRequestException(
            StatusCodes.Status429TooManyRequests,
            "PLAYBACK_EVENT_LIMIT_REACHED");
      }
      if (sequence <= state.HighestSequence)
      {
        state.AcceptedEvents.Add(eventId, signature);
        return;
      }

      try
      {
        await apply(state).ConfigureAwait(false);
      }
      catch (Exception exception) when (exception is not PlaybackRequestException)
      {
        state.PlaybackStarted = true;
        state.HighestSequence = sequence;
        state.AmbiguousEvents.Add(eventId, signature);
        throw AmbiguousMutation();
      }
      state.PlaybackStarted = true;
      state.HighestSequence = sequence;
      state.AcceptedEvents.Add(eventId, signature);
    }
    finally
    {
      state.Gate.Release();
    }
  }

  public async Task CloseAsync(
      string sessionId,
      string operationId,
      string signature,
      Func<PlaybackSessionState, Task> apply,
      CancellationToken cancellationToken)
  {
    var state = Get(sessionId);
    await state.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      RequireUnexpired(state);
      if (state.Closed)
      {
        if (string.Equals(state.CloseOperationId, operationId, StringComparison.Ordinal)
            && string.Equals(state.CloseSignature, signature, StringComparison.Ordinal))
        {
          if (state.CloseAmbiguous)
          {
            throw AmbiguousMutation();
          }
          return;
        }

        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      try
      {
        await apply(state).ConfigureAwait(false);
      }
      catch (Exception exception) when (exception is not PlaybackRequestException)
      {
        state.Closed = true;
        state.CloseAmbiguous = true;
        state.CloseOperationId = operationId;
        state.CloseSignature = signature;
        throw AmbiguousMutation();
      }
      state.Closed = true;
      state.CloseOperationId = operationId;
      state.CloseSignature = signature;
    }
    finally
    {
      state.Gate.Release();
    }
  }

  private static void RequireTrackMembership(
      PlaybackPlan plan,
      int? selectedIndex,
      string expectedType)
  {
    if (selectedIndex.HasValue
        && !plan.Tracks.Any(track =>
            track.Index == selectedIndex.Value
            && string.Equals(track.Type, expectedType, StringComparison.Ordinal)))
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "TRACK_SELECTION_REQUIRES_REPLAN");
    }
  }

  private void RemoveExpiredPlans(DateTimeOffset now)
  {
    foreach (var plan in _plansByNonce.Where(entry => entry.Value.ExpiresAt <= now).ToArray())
    {
      _plansByNonce.TryRemove(plan.Key, out _);
    }
  }

  private async Task RemoveExpiredSessionsAsync(CancellationToken cancellationToken)
  {
    var now = _timeProvider.GetUtcNow();
    foreach (var session in _sessionsById.Values.Where(session => session.ExpiresAt <= now).ToArray())
    {
      await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
      try
      {
        if (session.ExpiresAt > _timeProvider.GetUtcNow())
        {
          continue;
        }

        _sessionsById.TryRemove(session.Output.SessionId, out _);
        _sessionsByPlanId.TryRemove(session.OpenRequest.PlanId, out _);
        _sessionsByPlanNonce.TryRemove(session.Plan.Nonce, out _);
        _sessionsByOperationId.TryRemove(session.OpenRequest.OperationId, out _);
      }
      finally
      {
        session.Gate.Release();
      }
    }
    foreach (var ambiguous in _ambiguousOpensByOperationId
        .Where(entry => entry.Value.ExpiresAt <= now)
        .ToArray())
    {
      _ambiguousOpensByOperationId.TryRemove(ambiguous.Key, out _);
      _ambiguousOpenOperationByPlanId.TryRemove(ambiguous.Value.Request.PlanId, out _);
      _ambiguousOpenOperationByPlanNonce.TryRemove(ambiguous.Value.PlanNonce, out _);
    }
  }

  private void RequireUnexpired(PlaybackSessionState state)
  {
    if (state.ExpiresAt <= _timeProvider.GetUtcNow())
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }
  }

  private void CommitOpenedSession(
      PlaybackPlan plan,
      PlaybackOpenRequest request,
      PlaybackSessionState created)
  {
    if (!_sessionsByPlanNonce.TryAdd(plan.Nonce, created))
    {
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    if (!_sessionsByPlanId.TryAdd(request.PlanId, created))
    {
      _sessionsByPlanNonce.TryRemove(plan.Nonce, out _);
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    if (!_sessionsByOperationId.TryAdd(request.OperationId, created))
    {
      _sessionsByPlanId.TryRemove(request.PlanId, out _);
      _sessionsByPlanNonce.TryRemove(plan.Nonce, out _);
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    if (!_sessionsById.TryAdd(created.Output.SessionId, created))
    {
      _sessionsByOperationId.TryRemove(request.OperationId, out _);
      _sessionsByPlanId.TryRemove(request.PlanId, out _);
      _sessionsByPlanNonce.TryRemove(plan.Nonce, out _);
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
  }

  private static PlaybackRequestException AmbiguousMutation()
  {
    return new PlaybackRequestException(
        StatusCodes.Status503ServiceUnavailable,
        "PLAYBACK_MUTATION_AMBIGUOUS");
  }

  private static void RequireMatchingAmbiguousOpen(
      AmbiguousPlaybackOpen replay,
      PlaybackOpenRequest request)
  {
    var selectedAudioTrackIndex =
        request.AudioTrackIndex ?? replay.SelectedAudioTrackIndex;
    if (!string.Equals(replay.Request.PlanId, request.PlanId, StringComparison.Ordinal)
        || selectedAudioTrackIndex != replay.SelectedAudioTrackIndex
        || replay.Request.SubtitleDisabled != request.SubtitleDisabled
        || replay.Request.SubtitleTrackIndex != request.SubtitleTrackIndex)
    {
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    throw AmbiguousMutation();
  }

  private void RetainAmbiguousOpen(
      PlaybackPlan plan,
      PlaybackOpenRequest request)
  {
    var expiresAt = _timeProvider.GetUtcNow()
        + TimeSpan.FromTicks(plan.RuntimeTicks)
        + PlaybackConstants.SessionGrace;
    var selectedAudioTrackIndex =
        request.AudioTrackIndex ?? plan.Negotiation?.AudioTrackIndex;
    var ambiguous = new AmbiguousPlaybackOpen(
        request,
        selectedAudioTrackIndex,
        plan.Nonce,
        expiresAt);
    if (!_ambiguousOpensByOperationId.TryAdd(request.OperationId, ambiguous))
    {
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    if (!_ambiguousOpenOperationByPlanId.TryAdd(request.PlanId, request.OperationId))
    {
      _ambiguousOpensByOperationId.TryRemove(request.OperationId, out _);
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
    if (!_ambiguousOpenOperationByPlanNonce.TryAdd(plan.Nonce, request.OperationId))
    {
      _ambiguousOpenOperationByPlanId.TryRemove(request.PlanId, out _);
      _ambiguousOpensByOperationId.TryRemove(request.OperationId, out _);
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
  }

  private static PlaybackSessionState RequireMatchingReplay(
      PlaybackSessionState replay,
      PlaybackOpenRequest request)
  {
    var selectedAudioTrackIndex =
        request.AudioTrackIndex ?? replay.Output.SelectedAudioTrackIndex;
    if (!string.Equals(replay.OpenRequest.PlanId, request.PlanId, StringComparison.Ordinal)
        || selectedAudioTrackIndex != replay.Output.SelectedAudioTrackIndex
        || replay.OpenRequest.SubtitleDisabled != request.SubtitleDisabled
        || replay.OpenRequest.SubtitleTrackIndex != request.SubtitleTrackIndex)
    {
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }

    return replay;
  }

}
