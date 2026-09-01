using Microsoft.AspNetCore.Http;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Nama.Jellyfin.Extension.Tests;

[TestClass]
public sealed class PlaybackSessionStoreTests
{
  private const int EventCapacityForOneSecondRuntime = 2_169;
  [TestMethod]
  public void StorePlanRejectsFirstPlanBeyondLimit()
  {
    var store = new PlaybackSessionStore();
    var expiresAt = DateTimeOffset.UtcNow.AddHours(1);
    for (var index = 0; index < 128; index++)
    {
      store.StorePlan(CreatePlan($"plan-{index}"), expiresAt);
    }

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(
        () => store.StorePlan(CreatePlan("plan-over-limit"), expiresAt));

    Assert.AreEqual(StatusCodes.Status429TooManyRequests, exception.StatusCode);
    Assert.AreEqual("PLAYBACK_PLAN_LIMIT_REACHED", exception.Reason);
  }

  [TestMethod]
  public void StorePlanExcludesExpiredPlansFromCapacity()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    var expiresAt = clock.GetUtcNow().AddMinutes(1);
    for (var index = 0; index < 128; index++)
    {
      store.StorePlan(CreatePlan($"plan-{index}"), expiresAt);
    }

    clock.Advance(TimeSpan.FromMinutes(1));

    store.StorePlan(CreatePlan("replacement-plan"), clock.GetUtcNow().AddMinutes(1));
  }

  [TestMethod]
  public async Task OpenRejectsFirstSessionBeyondLimitBeforeCreation()
  {
    var store = new PlaybackSessionStore();
    var expiresAt = DateTimeOffset.UtcNow.AddHours(1);
    for (var index = 0; index < 16; index++)
    {
      await OpenSessionAsync(store, index, expiresAt);
    }

    var createInvoked = false;
    var plan = CreatePlan("plan-over-limit");
    var request = CreateOpenRequest("open-over-limit");
    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(async () =>
    {
      await store.OpenAsync(
          request,
          () => plan,
          _ =>
          {
            createInvoked = true;
            return Task.FromResult(CreateSession(plan, request, "session-over-limit", expiresAt));
          });
    });

    Assert.AreEqual(StatusCodes.Status429TooManyRequests, exception.StatusCode);
    Assert.AreEqual("PLAYBACK_SESSION_LIMIT_REACHED", exception.Reason);
    Assert.IsFalse(createInvoked);
  }

  [TestMethod]
  public async Task MatchingOpenReplayWinsAtSessionLimit()
  {
    var store = new PlaybackSessionStore();
    var expiresAt = DateTimeOffset.UtcNow.AddHours(1);
    PlaybackSessionState? first = null;
    for (var index = 0; index < 16; index++)
    {
      var opened = await OpenSessionAsync(store, index, expiresAt);
      first ??= opened;
    }

    var createInvoked = false;
    var replay = await store.OpenAsync(
        first!.OpenRequest,
        () => throw new AssertFailedException("matching replay resolved its plan"),
        _ =>
        {
          createInvoked = true;
          throw new AssertFailedException("matching replay created another session");
        });

    Assert.AreSame(first, replay);
    Assert.IsFalse(createInvoked);
  }

  [TestMethod]
  public async Task OpenProviderFailureRetainsAmbiguityIdentity()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("ambiguous-open");
    var request = CreateOpenRequest("ambiguous-open");
    var providerInvocations = 0;
    Task<PlaybackSessionState> CommitThenThrow(PlaybackPlan _)
    {
      providerInvocations++;
      return Task.FromException<PlaybackSessionState>(
          new InvalidOperationException("provider committed before response failure"));
    }

    var first = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.OpenAsync(request, () => plan, CommitThenThrow));
    var replay = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.OpenAsync(request, () => plan, CommitThenThrow));

    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, first.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", first.Reason);
    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, replay.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", replay.Reason);
    Assert.AreEqual(1, providerInvocations);
  }

  [TestMethod]
  public async Task OpenProviderFailureReplaysEquivalentDefaultSelection()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("ambiguous-default-open") with
    {
      Tracks =
      [
        new PlaybackTrackModel(0, "audio", "aac", 2, true, false, null, null, null)
      ]
    };
    var request = new PlaybackOpenRequest(
        "ambiguous-default-open",
        "ambiguous-default-plan",
        0,
        true,
        null);
    var providerInvocations = 0;
    Task<PlaybackSessionState> CommitThenThrow(PlaybackPlan _)
    {
      providerInvocations++;
      return Task.FromException<PlaybackSessionState>(
          new InvalidOperationException("provider committed before response failure"));
    }
    var first = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.OpenAsync(request, () => plan, CommitThenThrow));

    var replay = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.OpenAsync(
            request with { AudioTrackIndex = null },
            () => throw new AssertFailedException("ambiguous Open replay resolved its plan"),
            _ => throw new AssertFailedException("ambiguous Open replay re-entered the provider")));

    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, first.StatusCode);
    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, replay.StatusCode);
    Assert.AreEqual(1, providerInvocations);
  }

  [TestMethod]
  public async Task ReportProviderFailureRetainsAmbiguityIdentity()
  {
    var store = new PlaybackSessionStore();
    var session = await OpenSessionAsync(store, 0, DateTimeOffset.UtcNow.AddHours(1));
    var providerInvocations = 0;
    Task CommitThenThrow(PlaybackSessionState _)
    {
      providerInvocations++;
      return Task.FromException(
          new InvalidOperationException("provider committed before response failure"));
    }

    var first = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.ReportAsync(
            session.Output.SessionId,
            "ambiguous-report",
            "ambiguous-report-signature",
            1,
            CommitThenThrow,
            CancellationToken.None));
    var replay = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.ReportAsync(
            session.Output.SessionId,
            "ambiguous-report",
            "ambiguous-report-signature",
            1,
            CommitThenThrow,
            CancellationToken.None));

    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, first.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", first.Reason);
    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, replay.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", replay.Reason);
    Assert.AreEqual(1, providerInvocations);
  }

  [TestMethod]
  public async Task ReportProviderFailureRetainsAdmittedState()
  {
    var store = new PlaybackSessionStore();
    var session = await OpenSessionAsync(store, 0, DateTimeOffset.UtcNow.AddHours(1));
    var providerInvocations = 0;
    var first = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.ReportAsync(
            session.Output.SessionId,
            "ambiguous-state-report",
            "ambiguous-state-signature",
            1,
            _ =>
            {
              providerInvocations++;
              return Task.FromException(
                  new InvalidOperationException("provider committed before response failure"));
            },
            CancellationToken.None));
    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, first.StatusCode);

    await store.ReportAsync(
        session.Output.SessionId,
        "same-sequence-after-ambiguity",
        "same-sequence-after-ambiguity-signature",
        1,
        _ =>
        {
          providerInvocations++;
          return Task.CompletedTask;
        },
        CancellationToken.None);
    var playbackWasStarted = false;
    await store.ReportAsync(
        session.Output.SessionId,
        "later-sequence-after-ambiguity",
        "later-sequence-after-ambiguity-signature",
        2,
        state =>
        {
          playbackWasStarted = state.PlaybackStarted;
          return Task.CompletedTask;
        },
        CancellationToken.None);

    Assert.AreEqual(1, providerInvocations);
    Assert.IsTrue(playbackWasStarted);
  }

  [TestMethod]
  public async Task CloseProviderFailureRetainsAmbiguityIdentity()
  {
    var store = new PlaybackSessionStore();
    var session = await OpenSessionAsync(store, 0, DateTimeOffset.UtcNow.AddHours(1));
    var providerInvocations = 0;
    Task CommitThenThrow(PlaybackSessionState _)
    {
      providerInvocations++;
      return Task.FromException(
          new InvalidOperationException("provider committed before response failure"));
    }

    var first = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.CloseAsync(
            session.Output.SessionId,
            "ambiguous-close",
            "ambiguous-close-signature",
            CommitThenThrow,
            CancellationToken.None));
    var replay = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await store.CloseAsync(
            session.Output.SessionId,
            "ambiguous-close",
            "ambiguous-close-signature",
            CommitThenThrow,
            CancellationToken.None));

    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, first.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", first.Reason);
    Assert.AreEqual(StatusCodes.Status503ServiceUnavailable, replay.StatusCode);
    Assert.AreEqual("PLAYBACK_MUTATION_AMBIGUOUS", replay.Reason);
    Assert.AreEqual(1, providerInvocations);
  }

  [TestMethod]
  public async Task ReportRejectsFirstNewEventBeyondDurationDerivedLimitBeforeMutation()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("event-capacity", TimeSpan.FromSeconds(1));
    var request = CreateOpenRequest("event-capacity");
    var expiresAt = DateTimeOffset.UtcNow + TimeSpan.FromTicks(plan.RuntimeTicks) + PlaybackConstants.SessionGrace;
    var session = await OpenSessionAsync(store, plan, request, "event-capacity-session", expiresAt);
    var capacity = EventCapacityForOneSecondRuntime;
    await FillEventCapacityAsync(store, session.Output.SessionId, capacity);
    var mutationInvoked = false;

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(async () =>
    {
      await store.ReportAsync(
          session.Output.SessionId,
          "event-over-limit",
          "event-over-limit-signature",
          1,
          _ =>
          {
            mutationInvoked = true;
            return Task.CompletedTask;
          },
          CancellationToken.None);
    });

    Assert.AreEqual(StatusCodes.Status429TooManyRequests, exception.StatusCode);
    Assert.AreEqual("PLAYBACK_EVENT_LIMIT_REACHED", exception.Reason);
    Assert.IsFalse(mutationInvoked);
  }

  [TestMethod]
  public async Task MatchingEventReplayWinsAtEventLimit()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("event-replay", TimeSpan.FromSeconds(1));
    var request = CreateOpenRequest("event-replay");
    var expiresAt = DateTimeOffset.UtcNow + TimeSpan.FromTicks(plan.RuntimeTicks) + PlaybackConstants.SessionGrace;
    var session = await OpenSessionAsync(store, plan, request, "event-replay-session", expiresAt);
    await FillEventCapacityAsync(
        store,
        session.Output.SessionId,
        EventCapacityForOneSecondRuntime);

    await store.ReportAsync(
        session.Output.SessionId,
        "event-0",
        "signature-0",
        1,
        _ => throw new AssertFailedException("matching event replay invoked provider telemetry"),
        CancellationToken.None);
  }

  [TestMethod]
  public async Task ConflictingEventReplayRemainsConflictAtEventLimit()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("event-conflict", TimeSpan.FromSeconds(1));
    var request = CreateOpenRequest("event-conflict");
    var expiresAt = DateTimeOffset.UtcNow + TimeSpan.FromTicks(plan.RuntimeTicks) + PlaybackConstants.SessionGrace;
    var session = await OpenSessionAsync(store, plan, request, "event-conflict-session", expiresAt);
    await FillEventCapacityAsync(
        store,
        session.Output.SessionId,
        EventCapacityForOneSecondRuntime);

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(async () =>
    {
      await store.ReportAsync(
          session.Output.SessionId,
          "event-0",
          "different-signature",
          1,
          _ => throw new AssertFailedException("conflicting event replay invoked provider telemetry"),
          CancellationToken.None);
    });

    Assert.AreEqual(StatusCodes.Status409Conflict, exception.StatusCode);
  }

  [TestMethod]
  public async Task OpenExcludesExpiredSessionsFromCapacity()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    await OpenSessionAsync(store, 0, clock.GetUtcNow().AddMinutes(1));
    for (var index = 1; index < 16; index++)
    {
      await OpenSessionAsync(store, index, clock.GetUtcNow().AddHours(1));
    }

    clock.Advance(TimeSpan.FromMinutes(1));

    await OpenSessionAsync(store, 16, clock.GetUtcNow().AddHours(1));
  }

  [TestMethod]
  public async Task ExpiryCleanupDoesNotDisposeCoordinationHeldByReport()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    var session = await OpenSessionAsync(store, 0, clock.GetUtcNow().AddMinutes(1));
    var mutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var report = store.ReportAsync(
        session.Output.SessionId,
        "held-report",
        "held-report-signature",
        1,
        async _ =>
        {
          mutationStarted.SetResult();
          await releaseMutation.Task;
        },
        CancellationToken.None);
    await mutationStarted.Task;
    clock.Advance(TimeSpan.FromMinutes(1));

    var replacement = OpenSessionAsync(store, 1, clock.GetUtcNow().AddHours(1));
    releaseMutation.SetResult();

    await report;
    await replacement;
  }

  [TestMethod]
  public async Task ExpiryCleanupDoesNotDisposeCoordinationHeldByClose()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    var session = await OpenSessionAsync(store, 0, clock.GetUtcNow().AddMinutes(1));
    var mutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var close = store.CloseAsync(
        session.Output.SessionId,
        "held-close",
        "held-close-signature",
        async _ =>
        {
          mutationStarted.SetResult();
          await releaseMutation.Task;
        },
        CancellationToken.None);
    await mutationStarted.Task;
    clock.Advance(TimeSpan.FromMinutes(1));

    var replacement = OpenSessionAsync(store, 1, clock.GetUtcNow().AddHours(1));
    releaseMutation.SetResult();

    await close;
    await replacement;
  }

  [TestMethod]
  public async Task ReportWaitingPastExpiryIsRejectedBeforeMutation()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    var session = await OpenSessionAsync(store, 0, clock.GetUtcNow().AddMinutes(1));
    var firstMutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseFirstMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var firstReport = store.ReportAsync(
        session.Output.SessionId,
        "first-report",
        "first-report-signature",
        1,
        async _ =>
        {
          firstMutationStarted.SetResult();
          await releaseFirstMutation.Task;
        },
        CancellationToken.None);
    await firstMutationStarted.Task;
    var secondMutationInvoked = false;
    var waitingReport = store.ReportAsync(
        session.Output.SessionId,
        "waiting-report",
        "waiting-report-signature",
        2,
        _ =>
        {
          secondMutationInvoked = true;
          return Task.CompletedTask;
        },
        CancellationToken.None);
    clock.Advance(TimeSpan.FromMinutes(1));
    releaseFirstMutation.SetResult();
    await firstReport;

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await waitingReport);

    Assert.AreEqual(StatusCodes.Status404NotFound, exception.StatusCode);
    Assert.IsFalse(secondMutationInvoked);
  }

  [TestMethod]
  public async Task CloseWaitingPastExpiryIsRejectedBeforeMutation()
  {
    var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero));
    var store = new PlaybackSessionStore(clock);
    var session = await OpenSessionAsync(store, 0, clock.GetUtcNow().AddMinutes(1));
    var firstMutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseFirstMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var report = store.ReportAsync(
        session.Output.SessionId,
        "first-report",
        "first-report-signature",
        1,
        async _ =>
        {
          firstMutationStarted.SetResult();
          await releaseFirstMutation.Task;
        },
        CancellationToken.None);
    await firstMutationStarted.Task;
    var closeMutationInvoked = false;
    var waitingClose = store.CloseAsync(
        session.Output.SessionId,
        "waiting-close",
        "waiting-close-signature",
        _ =>
        {
          closeMutationInvoked = true;
          return Task.CompletedTask;
        },
        CancellationToken.None);
    clock.Advance(TimeSpan.FromMinutes(1));
    releaseFirstMutation.SetResult();
    await report;

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await waitingClose);

    Assert.AreEqual(StatusCodes.Status404NotFound, exception.StatusCode);
    Assert.IsFalse(closeMutationInvoked);
  }

  [TestMethod]
  public async Task CanceledOpenWaitingForAdmissionDoesNotCreateSession()
  {
    var store = new PlaybackSessionStore();
    var firstPlan = CreatePlan("held-open");
    var firstRequest = CreateOpenRequest("held-open");
    var expiresAt = DateTimeOffset.UtcNow.AddHours(1);
    var firstCreationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseFirstCreation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var firstOpen = store.OpenAsync(
        firstRequest,
        () => firstPlan,
        async _ =>
        {
          firstCreationStarted.SetResult();
          await releaseFirstCreation.Task;
          return CreateSession(firstPlan, firstRequest, "held-open-session", expiresAt);
        });
    await firstCreationStarted.Task;
    var canceledPlan = CreatePlan("canceled-open");
    var canceledRequest = CreateOpenRequest("canceled-open");
    var canceledCreateInvoked = false;
    using var cancellation = new CancellationTokenSource();
    var canceledOpen = store.OpenAsync(
        canceledRequest,
        () => canceledPlan,
        _ =>
        {
          canceledCreateInvoked = true;
          return Task.FromResult(
              CreateSession(canceledPlan, canceledRequest, "canceled-open-session", expiresAt));
        },
        cancellation.Token);
    await cancellation.CancelAsync();

    await Assert.ThrowsAsync<OperationCanceledException>(async () => await canceledOpen);
    Assert.IsFalse(canceledCreateInvoked);

    releaseFirstCreation.SetResult();
    await firstOpen;
  }

  [TestMethod]
  public async Task OpenCommitsReplayAfterCancellationDuringCreation()
  {
    var store = new PlaybackSessionStore();
    var plan = CreatePlan("cancel-after-open");
    var request = CreateOpenRequest("cancel-after-open");
    var expiresAt = DateTimeOffset.UtcNow.AddHours(1);
    var creationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseCreation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var cancellation = new CancellationTokenSource();
    var opening = store.OpenAsync(
        request,
        () => plan,
        async _ =>
        {
          creationStarted.SetResult();
          await releaseCreation.Task;
          return CreateSession(plan, request, "cancel-after-open-session", expiresAt);
        },
        cancellation.Token);
    await creationStarted.Task;
    await cancellation.CancelAsync();
    releaseCreation.SetResult();

    var opened = await opening;
    var replay = await store.OpenAsync(
        request,
        () => throw new AssertFailedException("accepted Open replay resolved its plan"),
        _ => throw new AssertFailedException("accepted Open replay created another session"));

    Assert.AreSame(opened, replay);
  }

  [TestMethod]
  public async Task ReportCommitsReplayAfterCancellationDuringMutation()
  {
    var store = new PlaybackSessionStore();
    var session = await OpenSessionAsync(store, 0, DateTimeOffset.UtcNow.AddHours(1));
    var mutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var cancellation = new CancellationTokenSource();
    var report = store.ReportAsync(
        session.Output.SessionId,
        "cancel-after-report",
        "cancel-after-report-signature",
        1,
        async _ =>
        {
          mutationStarted.SetResult();
          await releaseMutation.Task;
        },
        cancellation.Token);
    await mutationStarted.Task;
    await cancellation.CancelAsync();
    releaseMutation.SetResult();
    await report;

    await store.ReportAsync(
        session.Output.SessionId,
        "cancel-after-report",
        "cancel-after-report-signature",
        1,
        _ => throw new AssertFailedException("accepted Report replay invoked provider telemetry"),
        CancellationToken.None);
  }

  [TestMethod]
  public async Task CloseCommitsReplayAfterCancellationDuringMutation()
  {
    var store = new PlaybackSessionStore();
    var session = await OpenSessionAsync(store, 0, DateTimeOffset.UtcNow.AddHours(1));
    var mutationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseMutation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var cancellation = new CancellationTokenSource();
    var close = store.CloseAsync(
        session.Output.SessionId,
        "cancel-after-close",
        "cancel-after-close-signature",
        async _ =>
        {
          mutationStarted.SetResult();
          await releaseMutation.Task;
        },
        cancellation.Token);
    await mutationStarted.Task;
    await cancellation.CancelAsync();
    releaseMutation.SetResult();
    await close;

    await store.CloseAsync(
        session.Output.SessionId,
        "cancel-after-close",
        "cancel-after-close-signature",
        _ => throw new AssertFailedException("accepted Close replay invoked provider telemetry"),
        CancellationToken.None);
  }

  private static async Task FillEventCapacityAsync(
      PlaybackSessionStore store,
      string sessionId,
      int capacity)
  {
    for (var index = 0; index < capacity; index++)
    {
      await store.ReportAsync(
          sessionId,
          $"event-{index}",
          $"signature-{index}",
          1,
          _ => Task.CompletedTask,
          CancellationToken.None);
    }
  }


  private static Task<PlaybackSessionState> OpenSessionAsync(
      PlaybackSessionStore store,
      int index,
      DateTimeOffset expiresAt)
  {
    var plan = CreatePlan($"plan-{index}");
    var request = CreateOpenRequest($"open-{index}");
    return store.OpenAsync(
        request,
        () => plan,
        _ => Task.FromResult(CreateSession(plan, request, $"session-{index}", expiresAt)));
  }

  private static Task<PlaybackSessionState> OpenSessionAsync(
      PlaybackSessionStore store,
      PlaybackPlan plan,
      PlaybackOpenRequest request,
      string sessionId,
      DateTimeOffset expiresAt)
  {
    return store.OpenAsync(
        request,
        () => plan,
        _ => Task.FromResult(CreateSession(plan, request, sessionId, expiresAt)));
  }

  private static PlaybackOpenRequest CreateOpenRequest(string identity)
  {
    return new PlaybackOpenRequest(identity, $"{identity}-plan", null, true, null);
  }

  private static PlaybackSessionState CreateSession(
      PlaybackPlan plan,
      PlaybackOpenRequest request,
      string sessionId,
      DateTimeOffset expiresAt)
  {
    var output = new OpenPlaybackOutput(
        sessionId,
        plan.ItemId.ToString("N"),
        plan.SourceId,
        "media-resource",
        "lease",
        "http",
        "video/mp4",
        expiresAt,
        PlaybackConstants.ReportIntervalSeconds,
        [],
        0,
        null,
        [],
        "session-context");
    return new PlaybackSessionState(
        plan,
        request,
        $"jellyfin-{sessionId}",
        expiresAt,
        output);
  }

  private static PlaybackPlan CreatePlan(string nonce, TimeSpan? runtime = null)
  {
    return new PlaybackPlan(
        nonce,
        Guid.NewGuid(),
        "source",
        Guid.NewGuid(),
        (runtime ?? TimeSpan.FromMinutes(1)).Ticks,
        0,
        null!,
        null!,
        []);
  }
}
