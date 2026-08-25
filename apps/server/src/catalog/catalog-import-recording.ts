import { Clock, Effect } from "effect";

import type { CatalogScanLease, FailCatalogScanInput } from "../database/catalog-persistence.ts";
import { attempt, schedulingFailure } from "./catalog-import-effects.ts";
import { retryDelayMilliseconds } from "./catalog-import-failure.ts";
import type { ClassifiedCatalogFailure } from "./catalog-import-failure.ts";
import type { CatalogImportDependencies } from "./catalog-import-model.ts";

interface FailureArguments {
  readonly dependencies: CatalogImportDependencies;
  readonly failure: ClassifiedCatalogFailure;
  readonly scan: CatalogScanLease;
}

interface FailureInputArguments extends FailureArguments {
  readonly nextRetryAt: Date | undefined;
}

const failureInput = (failureArguments: FailureInputArguments): FailCatalogScanInput => {
  const input = {
    coreRunId: failureArguments.dependencies.coreRunId,
    providerInstanceId: failureArguments.scan.providerInstanceId,
    reason: failureArguments.failure.reason,
    revision: failureArguments.scan.revision,
  };
  if (failureArguments.nextRetryAt === undefined) {
    return input;
  }
  return { ...input, nextRetryAt: failureArguments.nextRetryAt };
};

const failureRetryAt = (failureArguments: FailureArguments, now: number): Date | undefined => {
  if (!failureArguments.failure.retryable) {
    return undefined;
  }
  const delay = retryDelayMilliseconds(
    failureArguments.scan.failureCount,
    failureArguments.failure.retryAfterMilliseconds,
    failureArguments.dependencies.random,
  );
  return new Date(now + delay);
};

const recordFailure = (
  dependencies: CatalogImportDependencies,
  scan: CatalogScanLease,
  failure: ClassifiedCatalogFailure,
): Effect.Effect<void> =>
  Effect.gen(function* persistCatalogFailure() {
    const now = yield* Clock.currentTimeMillis;
    const failureArguments = { dependencies, failure, scan };
    const input = failureInput({
      ...failureArguments,
      nextRetryAt: failureRetryAt(failureArguments, now),
    });
    const persistence = dependencies.catalog.failScan(input);
    const activity = dependencies.runProviderActivity(scan.providerInstanceId, persistence);
    const recorded = yield* attempt(activity);
    if (recorded.kind === "failure") {
      yield* schedulingFailure;
    }
  });

export { recordFailure };
