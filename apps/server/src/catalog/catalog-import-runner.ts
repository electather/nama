import type { ListItemsResponse } from "@nama/api/nama/plugin/v1/library_pb.js";
import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AcceptCatalogPageInput,
  CatalogPageAcceptance,
  CatalogScanLease,
  ResolveCatalogPageInput,
} from "../database/catalog-persistence.ts";
import { ProviderInstanceBusy } from "../provider/provider-activity.ts";
import type { ProviderInstanceBusyFailure } from "../provider/provider-activity.ts";
import { attempt, schedulingFailure } from "./catalog-import-effects.ts";
import type { Attempt } from "./catalog-import-effects.ts";
import { classifyCatalogFailure, isInvalidContinuationFailure } from "./catalog-import-failure.ts";
import type { ClassifiedCatalogFailure } from "./catalog-import-failure.ts";
import type {
  CatalogImportDependencies,
  CatalogProviderAccessFailure,
  CatalogScanRequest,
} from "./catalog-import-model.ts";
import { recordFailure } from "./catalog-import-recording.ts";
import { catalogPageFromPlugin } from "./catalog-item-mapper.ts";
import type { CatalogPluginPage } from "./catalog-item-mapper.ts";

const CATALOG_PAGE_SIZE = 100;
const ZERO_FAILURES = 0;
const scanRequest = (continuation: string | undefined): CatalogScanRequest => {
  if (continuation === undefined) {
    return { case: "begin", pageSize: CATALOG_PAGE_SIZE };
  }
  return { case: "continuation", value: continuation };
};

const pageAcceptanceInput = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  page: CatalogPluginPage,
): AcceptCatalogPageInput => {
  const input = {
    complete: page.complete,
    coreRunId: dependencies.coreRunId,
    items: page.items,
    providerInstanceId: scan.providerInstanceId,
    revision: scan.revision,
  };
  if (page.nextContinuation === undefined) {
    return input;
  }
  return { ...input, nextContinuation: page.nextContinuation };
};

const pageResolutionInput = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  page: CatalogPluginPage,
): ResolveCatalogPageInput => {
  const input = {
    complete: page.complete,
    coreRunId: dependencies.coreRunId,
    itemReferences: page.items.map((item) => item.itemReference),
    providerInstanceId: scan.providerInstanceId,
    revision: scan.revision,
  };
  if (page.nextContinuation === undefined) {
    return input;
  }
  return { ...input, nextContinuation: page.nextContinuation };
};

const resolveCatalogPage = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  page: CatalogPluginPage,
): Effect.Effect<"accepted" | "ambiguous"> =>
  Effect.gen(function* resolveAmbiguousCatalogPage() {
    const resolution = dependencies.catalog.resolvePageAcceptance(
      pageResolutionInput(dependencies, scan, page),
    );
    const activity = dependencies.runProviderActivity(scan.providerInstanceId, resolution);
    const resolved = yield* attempt(activity);
    if (resolved.kind === "success" && resolved.success) {
      return "accepted";
    }
    return "ambiguous";
  });

const acceptCatalogPage = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  page: CatalogPluginPage,
): Effect.Effect<"accepted" | "ambiguous" | "stale"> =>
  Effect.gen(function* acceptOrResolveCatalogPage() {
    const acceptance = dependencies.catalog.acceptPage(
      pageAcceptanceInput(dependencies, scan, page),
    );
    const activity = dependencies.runProviderActivity(scan.providerInstanceId, acceptance);
    const accepted = yield* attempt(activity);
    if (accepted.kind === "success") {
      return accepted.success;
    }
    if (accepted.failure instanceof ProviderInstanceBusy) {
      return "stale";
    }
    return yield* resolveCatalogPage(dependencies, scan, page);
  });

const restartInvalidContinuation = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
): Effect.Effect<CatalogPageAcceptance> =>
  Effect.gen(function* restartCatalogScan() {
    const restart = dependencies.catalog.restartScan({
      coreRunId: dependencies.coreRunId,
      providerInstanceId: scan.providerInstanceId,
      revision: scan.revision,
    });
    const activity = dependencies.runProviderActivity(scan.providerInstanceId, restart);
    const restarted = yield* attempt(activity);
    if (restarted.kind === "failure") {
      return "stale";
    }
    return restarted.success;
  });

interface ScanPageState {
  readonly continuation?: string;
  readonly restarted: boolean;
}
interface ScanPageContext {
  readonly dependencies: CatalogImportDependencies;
  readonly scan: CatalogScanLease;
  readonly state: ScanPageState;
}

type PageCallFailure = CatalogProviderAccessFailure | ProviderInstanceBusyFailure;
type ScanProgress =
  | Readonly<{
      readonly kind: "continue";
      readonly scan: CatalogScanLease;
      readonly state: ScanPageState;
    }>
  | Readonly<{ readonly kind: "stop" }>;

const SCAN_STOP: ScanProgress = Object.freeze({ kind: "stop" });

const resetScanBackoff = (scan: CatalogScanLease): CatalogScanLease => ({
  ...scan,
  failureCount: ZERO_FAILURES,
});

const continueScanning = (scan: CatalogScanLease, state: ScanPageState): ScanProgress => ({
  kind: "continue",
  scan,
  state,
});

const canRestartContinuation = (failure: PageCallFailure, state: ScanPageState): boolean =>
  state.continuation !== undefined && !state.restarted && isInvalidContinuationFailure(failure);

const failedCallNextState = (
  context: ScanPageContext,
  failure: PageCallFailure,
): Effect.Effect<ScanProgress> =>
  Effect.gen(function* handleCatalogCallFailure() {
    if (canRestartContinuation(failure, context.state)) {
      const restarted = yield* restartInvalidContinuation(context.dependencies, context.scan);
      if (restarted === "accepted") {
        return continueScanning(resetScanBackoff(context.scan), { restarted: true });
      }
      return SCAN_STOP;
    }
    const classified = classifyCatalogFailure(failure);
    if (classified !== undefined) {
      yield* recordFailure(context.dependencies, context.scan, classified);
    }
    return SCAN_STOP;
  });

const mapCatalogPage = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  response: ListItemsResponse,
): Effect.Effect<CatalogPluginPage, ClassifiedCatalogFailure> =>
  Effect.try({
    catch: () => ({ reason: "invalid_response", retryable: false }) as const,
    try: () => catalogPageFromPlugin(scan.providerInstanceId, dependencies.coreRunId, response),
  });

const nextPageState = (page: CatalogPluginPage, state: ScanPageState): ScanPageState => {
  if (page.nextContinuation === undefined) {
    return { restarted: state.restarted };
  }
  return { continuation: page.nextContinuation, restarted: state.restarted };
};

const persistMappedPage = (
  context: ScanPageContext,
  page: CatalogPluginPage,
): Effect.Effect<ScanProgress> =>
  Effect.gen(function* acceptMappedCatalogPage() {
    const acceptance = yield* acceptCatalogPage(context.dependencies, context.scan, page);
    if (acceptance === "ambiguous") {
      yield* recordFailure(context.dependencies, context.scan, {
        reason: "database_unavailable",
        retryable: true,
      });
      return SCAN_STOP;
    }
    if (acceptance === "stale" || page.complete) {
      return SCAN_STOP;
    }
    return continueScanning(resetScanBackoff(context.scan), nextPageState(page, context.state));
  });

const acceptedPageNextState = (
  context: ScanPageContext,
  response: ListItemsResponse,
): Effect.Effect<ScanProgress> =>
  Effect.gen(function* persistCatalogPage() {
    const mapped = yield* attempt(mapCatalogPage(context.dependencies, context.scan, response));
    if (mapped.kind === "failure") {
      yield* recordFailure(context.dependencies, context.scan, mapped.failure);
      return SCAN_STOP;
    }
    return yield* persistMappedPage(context, mapped.success);
  });

const callPage = (context: ScanPageContext) => {
  const listing = context.dependencies.listPage(
    context.scan,
    scanRequest(context.state.continuation),
  );
  const activity = context.dependencies.runProviderActivity(
    context.scan.providerInstanceId,
    listing,
  );
  return attempt(activity);
};

const calledPageNextState = (
  context: ScanPageContext,
  called: Attempt<ListItemsResponse, PageCallFailure>,
): Effect.Effect<ScanProgress> => {
  if (called.kind === "failure") {
    return failedCallNextState(context, called.failure);
  }
  return acceptedPageNextState(context, called.success);
};

const scanPages = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  state: ScanPageState,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* scanCatalogPages() {
    const context = { dependencies, scan, state };
    const called = yield* callPage(context);
    const progress = yield* calledPageNextState(context, called);
    if (progress.kind === "continue") {
      yield* scanPages(dependencies, progress.scan, progress.state);
    }
  });

const initialPageState = (scan: CatalogScanLease): ScanPageState => {
  if (scan.continuation === undefined) {
    return { restarted: false };
  }
  return { continuation: scan.continuation, restarted: false };
};

const scanCatalogCandidate = (
  dependencies: CatalogImportDependencies,
  providerInstanceId: string,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* scanCatalogCandidateEffect() {
      const admitted = yield* attempt(
        dependencies.catalog.beginScan({
          coreRunId: dependencies.coreRunId,
          providerInstanceId,
        }),
      );
      if (admitted.kind === "failure") {
        yield* schedulingFailure;
        return;
      }
      if (admitted.success !== undefined) {
        yield* scanPages(dependencies, admitted.success, initialPageState(admitted.success));
      }
    }),
  );

export { scanCatalogCandidate };
