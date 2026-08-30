import { Cause, Effect } from "effect";
import type { Scope } from "effect";

import { attempt, schedulingFailure } from "./catalog-import-effects.ts";
import type {
  CatalogImportDependencies,
  CatalogImportService,
  ReportCatalogFatalFailure,
} from "./catalog-import-model.ts";
import { scanCatalogCandidate } from "./catalog-import-runner.ts";

const SCHEDULER_POLL_MILLISECONDS = 1000;
const reportUnexpectedCause = (
  cause: Cause.Cause<unknown>,
  reportFatalFailure: ReportCatalogFatalFailure,
): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.void;
  }
  return reportFatalFailure(cause).pipe(Effect.asVoid);
};
const makeScheduler = (
  scanEligible: Effect.Effect<void, never, Scope.Scope>,
  reportFatalFailure: ReportCatalogFatalFailure,
) =>
  Effect.forever(Effect.andThen(scanEligible, Effect.sleep(SCHEDULER_POLL_MILLISECONDS))).pipe(
    Effect.catchCause((cause) => reportUnexpectedCause(cause, reportFatalFailure)),
  );

const makeScanProvider = (dependencies: CatalogImportDependencies) => {
  const active = new Set<string>();
  return (providerInstanceId: string) =>
    Effect.suspend(() => {
      if (active.has(providerInstanceId)) {
        return Effect.void;
      }
      active.add(providerInstanceId);
      return Effect.ensuring(
        scanCatalogCandidate(dependencies, providerInstanceId),
        Effect.sync(() => {
          active.delete(providerInstanceId);
        }),
      );
    });
};

const makeCatalogImport = (dependencies: CatalogImportDependencies): CatalogImportService => {
  const scanProvider = makeScanProvider(dependencies);
  const scanEligible = (reportFatalFailure: ReportCatalogFatalFailure) =>
    Effect.gen(function* scanEligibleCatalogs() {
      const paused = yield* attempt(
        dependencies.catalog.pauseDisabledScans(dependencies.coreRunId),
      );
      if (paused.kind === "failure") {
        yield* schedulingFailure;
      }
      const listed = yield* attempt(dependencies.catalog.listScanCandidates);
      if (listed.kind === "failure") {
        yield* schedulingFailure;
        return;
      }
      const scheduled = Effect.forEach(
        listed.success,
        (candidate) =>
          scanProvider(candidate.providerInstanceId).pipe(
            Effect.catchCause((cause) => reportUnexpectedCause(cause, reportFatalFailure)),
            Effect.forkScoped,
          ),
        { concurrency: "unbounded", discard: true },
      );
      yield* scheduled;
    });
  let started = false;
  const start: CatalogImportService["start"] = (reportFatalFailure) =>
    Effect.gen(function* startCatalogScheduler() {
      if (started) {
        return;
      }
      started = true;
      const scheduler = makeScheduler(scanEligible(reportFatalFailure), reportFatalFailure);
      yield* Effect.forkScoped(scheduler);
    });
  return Object.freeze({ start });
};

export { makeCatalogImport };
export type { CatalogImportDependencies, CatalogImportService } from "./catalog-import-model.ts";
