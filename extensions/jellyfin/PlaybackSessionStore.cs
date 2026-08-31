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
  }

  public SemaphoreSlim Gate { get; } = new(1, 1);

  public Dictionary<string, string> AcceptedEvents { get; } = new(StringComparer.Ordinal);

  public PlaybackPlan Plan { get; }

  public PlaybackOpenRequest OpenRequest { get; }

  public string JellyfinSessionId { get; }

  public DateTimeOffset ExpiresAt { get; }

  public OpenPlaybackOutput Output { get; }

  public ulong HighestSequence { get; set; }

  public bool PlaybackStarted { get; set; }

  public bool Closed { get; set; }

  public string? CloseOperationId { get; set; }

  public string? CloseSignature { get; set; }
}

internal sealed class PlaybackSessionStore
{
  private readonly SemaphoreSlim _openGate = new(1, 1);
  private readonly ConcurrentDictionary<string, StoredPlaybackPlan> _plansByNonce = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsById = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByPlanNonce = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByPlanId = new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, PlaybackSessionState> _sessionsByOperationId = new(StringComparer.Ordinal);

  public void StorePlan(PlaybackPlan plan, DateTimeOffset expiresAt)
  {
    RemoveExpiredPlans();
    if (!_plansByNonce.TryAdd(plan.Nonce, new StoredPlaybackPlan(plan, expiresAt)))
    {
      throw new PlaybackRequestException(StatusCodes.Status409Conflict);
    }
  }

  public PlaybackPlan GetPlan(string planNonce)
  {
    if (
        _plansByNonce.TryGetValue(planNonce, out var stored)
        && stored.ExpiresAt > DateTimeOffset.UtcNow)
    {
      return stored.Plan;
    }

    _plansByNonce.TryRemove(planNonce, out _);
    throw new PlaybackRequestException(StatusCodes.Status404NotFound);
  }

  public async Task<PlaybackSessionState> OpenAsync(
      PlaybackOpenRequest request,
      Func<PlaybackPlan> resolveLivePlan,
      Func<PlaybackPlan, Task<PlaybackSessionState>> create)
  {
    await _openGate.WaitAsync().ConfigureAwait(false);
    try
    {
      RemoveExpiredSessions();
      if (_sessionsByOperationId.TryGetValue(request.OperationId, out var replay))
      {
        return RequireMatchingReplay(replay, request);
      }
      if (_sessionsByPlanId.ContainsKey(request.PlanId))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      var plan = resolveLivePlan();
      if (_sessionsByPlanNonce.ContainsKey(plan.Nonce))
      {
        throw new PlaybackRequestException(StatusCodes.Status409Conflict);
      }

      var created = await create(plan).ConfigureAwait(false);
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
        && session.ExpiresAt > DateTimeOffset.UtcNow)
    {
      return session;
    }

    throw new PlaybackRequestException(StatusCodes.Status404NotFound);
  }

  private void RemoveExpiredPlans()
  {
    var now = DateTimeOffset.UtcNow;
    foreach (var plan in _plansByNonce.Where(entry => entry.Value.ExpiresAt <= now).ToArray())
    {
      _plansByNonce.TryRemove(plan.Key, out _);
    }
  }

  private void RemoveExpiredSessions()
  {
    var now = DateTimeOffset.UtcNow;
    foreach (var session in _sessionsById.Values.Where(session => session.ExpiresAt <= now).ToArray())
    {
      _sessionsById.TryRemove(session.Output.SessionId, out _);
      _sessionsByPlanId.TryRemove(session.OpenRequest.PlanId, out _);
      _sessionsByPlanNonce.TryRemove(session.Plan.Nonce, out _);
      _sessionsByOperationId.TryRemove(session.OpenRequest.OperationId, out _);
      session.Gate.Dispose();
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
