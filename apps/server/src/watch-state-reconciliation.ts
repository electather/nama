// oxlint-disable eslint/max-lines, typescript/prefer-readonly-parameter-types -- Replay helpers mutate one explicit in-memory accumulator while keeping the disposable proof in one file.
interface WatchState {
  readonly durationMs: number;
  readonly positionMs: number;
  readonly watched: boolean;
}

interface ProviderSource {
  readonly id: string;
  readonly priority: number;
}

interface NamaAction {
  readonly activityAt: number;
  readonly operationId: string;
  readonly state: WatchState;
  readonly type: "nama-action";
}

interface ProviderObservation {
  readonly activityAt: number | undefined;
  readonly providerId: string;
  readonly reliability: "heuristic" | "missing" | "reliable";
  readonly state: WatchState;
  readonly type: "provider-observation";
}

interface ProviderExportConfirmed {
  readonly canonicalVersion: number;
  readonly providerId: string;
  readonly state: WatchState;
  readonly type: "provider-export-confirmed";
}

type ReplayEvent = NamaAction | ProviderExportConfirmed | ProviderObservation;

interface CanonicalWatchState {
  readonly activityAt: number | undefined;
  readonly priority: number;
  readonly reliableActivity: boolean;
  readonly sourceId: string;
  readonly state: WatchState;
  readonly version: number;
}

interface ProviderExport {
  readonly canonicalVersion: number;
  readonly providerId: string;
  readonly state: WatchState;
}

interface ReplayResult {
  readonly canonical: CanonicalWatchState | undefined;
  readonly exports: readonly ProviderExport[];
  readonly providerStates: Readonly<Record<string, WatchState>>;
  readonly suppressedEchoes: number;
}

interface ActivityCandidate {
  readonly activityAt: number | undefined;
  readonly priority: number;
  readonly reliableActivity: boolean;
  readonly sourceId: string;
  readonly state: WatchState;
}

interface ReplayAccumulator {
  readonly appliedNamaOperations: Set<string>;
  canonical: CanonicalWatchState | undefined;
  readonly confirmedExportVersions: Record<string, number | undefined>;
  readonly exports: ProviderExport[];
  readonly pendingEchoes: Record<string, WatchState | undefined>;
  readonly providerStates: Record<string, WatchState>;
  readonly queuedExportVersions: Record<string, number | undefined>;
  suppressedEchoes: number;
}

const ECHO_INCREMENT = 1;
const NAMA_PRIORITY = 0;
const NO_VERSION = 0;
const VERSION_INCREMENT = 1;

const watchStatesEqual = (left: WatchState | undefined, right: WatchState): boolean =>
  left !== undefined &&
  left.durationMs === right.durationMs &&
  left.positionMs === right.positionMs &&
  left.watched === right.watched;

const observationsMatchCanonical = (
  canonical: CanonicalWatchState,
  candidate: ActivityCandidate,
): boolean =>
  canonical.sourceId === candidate.sourceId &&
  canonical.reliableActivity === candidate.reliableActivity &&
  canonical.activityAt === candidate.activityAt &&
  watchStatesEqual(canonical.state, candidate.state);

const providerObservationWins = (
  canonical: CanonicalWatchState,
  candidate: ActivityCandidate,
): boolean => {
  if (candidate.reliableActivity && canonical.reliableActivity) {
    if (candidate.activityAt !== canonical.activityAt) {
      return (
        candidate.activityAt !== undefined &&
        canonical.activityAt !== undefined &&
        candidate.activityAt > canonical.activityAt
      );
    }
    if (canonical.sourceId === candidate.sourceId) {
      return true;
    }
    return candidate.priority < canonical.priority;
  }
  if (canonical.sourceId === candidate.sourceId) {
    return true;
  }
  return candidate.priority < canonical.priority;
};

const providerPriority = (providers: readonly ProviderSource[], providerId: string): number => {
  const provider = providers.find(({ id }) => id === providerId);
  if (provider === undefined) {
    throw new Error(`Unknown provider source: ${providerId}`);
  }
  return provider.priority;
};

const queueProviderExport = (
  replay: ReplayAccumulator,
  providerId: string,
  canonical: CanonicalWatchState,
): void => {
  if (replay.queuedExportVersions[providerId] === canonical.version) {
    return;
  }
  replay.queuedExportVersions[providerId] = canonical.version;
  replay.exports.push({
    canonicalVersion: canonical.version,
    providerId,
    state: canonical.state,
  });
};
const commitCanonical = (
  replay: ReplayAccumulator,
  providers: readonly ProviderSource[],
  candidate: ActivityCandidate,
): void => {
  const version = (replay.canonical?.version ?? NO_VERSION) + VERSION_INCREMENT;
  const canonical: CanonicalWatchState = { ...candidate, version };
  replay.canonical = canonical;
  for (const provider of providers) {
    if (
      provider.id !== candidate.sourceId &&
      !watchStatesEqual(replay.providerStates[provider.id], candidate.state)
    ) {
      queueProviderExport(replay, provider.id, canonical);
    }
  }
};

const applyNamaAction = (
  replay: ReplayAccumulator,
  providers: readonly ProviderSource[],
  event: NamaAction,
): void => {
  if (replay.appliedNamaOperations.has(event.operationId)) {
    return;
  }
  replay.appliedNamaOperations.add(event.operationId);
  commitCanonical(replay, providers, {
    activityAt: event.activityAt,
    priority: NAMA_PRIORITY,
    reliableActivity: true,
    sourceId: "nama",
    state: event.state,
  });
};

const applyExportConfirmation = (
  replay: ReplayAccumulator,
  event: ProviderExportConfirmed,
): void => {
  const confirmedVersion = replay.confirmedExportVersions[event.providerId];
  if (confirmedVersion !== undefined && confirmedVersion >= event.canonicalVersion) {
    return;
  }
  replay.confirmedExportVersions[event.providerId] = event.canonicalVersion;
  const queuedVersion = replay.queuedExportVersions[event.providerId];
  if (queuedVersion !== undefined && queuedVersion <= event.canonicalVersion) {
    delete replay.queuedExportVersions[event.providerId];
  }
  replay.providerStates[event.providerId] = event.state;
  replay.pendingEchoes[event.providerId] = event.state;
};

const providerCandidate = (
  providers: readonly ProviderSource[],
  event: ProviderObservation,
): ActivityCandidate => {
  const { activityAt: observedActivityAt, providerId, reliability, state } = event;
  const reliableActivity = reliability === "reliable" && observedActivityAt !== undefined;
  let activityAt: number | undefined = undefined;
  if (reliableActivity) {
    activityAt = observedActivityAt;
  }
  return {
    activityAt,
    priority: providerPriority(providers, providerId),
    reliableActivity,
    sourceId: providerId,
    state,
  };
};
const restoreCanonicalProvider = (
  replay: ReplayAccumulator,
  canonical: CanonicalWatchState,
  candidate: ActivityCandidate,
): void => {
  const { state: canonicalState } = canonical;
  const { sourceId, state } = candidate;
  if (!watchStatesEqual(state, canonicalState)) {
    queueProviderExport(replay, sourceId, canonical);
  }
};
const reconcileProviderCandidate = (
  replay: ReplayAccumulator,
  providers: readonly ProviderSource[],
  candidate: ActivityCandidate,
): void => {
  const { canonical } = replay;
  if (canonical === undefined) {
    commitCanonical(replay, providers, candidate);
    return;
  }
  if (observationsMatchCanonical(canonical, candidate)) {
    return;
  }
  if (providerObservationWins(canonical, candidate)) {
    commitCanonical(replay, providers, candidate);
    return;
  }
  restoreCanonicalProvider(replay, canonical, candidate);
};
const applyProviderObservation = (
  replay: ReplayAccumulator,
  providers: readonly ProviderSource[],
  event: ProviderObservation,
): void => {
  const pendingEcho = replay.pendingEchoes[event.providerId];
  delete replay.pendingEchoes[event.providerId];
  replay.providerStates[event.providerId] = event.state;
  if (watchStatesEqual(pendingEcho, event.state)) {
    replay.suppressedEchoes += ECHO_INCREMENT;
    return;
  }

  const candidate = providerCandidate(providers, event);
  reconcileProviderCandidate(replay, providers, candidate);
};

const applyReplayEvent = (
  replay: ReplayAccumulator,
  providers: readonly ProviderSource[],
  event: ReplayEvent,
): void => {
  switch (event.type) {
    case "nama-action": {
      applyNamaAction(replay, providers, event);
      break;
    }
    case "provider-export-confirmed": {
      applyExportConfirmation(replay, event);
      break;
    }
    case "provider-observation": {
      applyProviderObservation(replay, providers, event);
      break;
    }
  }
};

const replayWatchState = (
  providers: readonly ProviderSource[],
  events: readonly ReplayEvent[],
): ReplayResult => {
  const replay: ReplayAccumulator = {
    appliedNamaOperations: new Set<string>(),
    canonical: undefined,
    confirmedExportVersions: {},
    exports: [],
    pendingEchoes: {},
    providerStates: {},
    queuedExportVersions: {},
    suppressedEchoes: NO_VERSION,
  };
  for (const event of events) {
    applyReplayEvent(replay, providers, event);
  }
  const { canonical, exports, providerStates, suppressedEchoes } = replay;
  return { canonical, exports, providerStates, suppressedEchoes };
};

export { replayWatchState, type ProviderSource, type ReplayEvent, type WatchState };
