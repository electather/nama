import { Code } from "@connectrpc/connect";

import type { CatalogScanFailureReason } from "../database/catalog-persistence.ts";
import { PluginDeadlineExceeded, PluginRpcError, PluginUnavailable } from "../plugin/errors.ts";
import { ProviderInstanceBusy } from "../provider/provider-activity.ts";
import type { ProviderInstanceBusyFailure } from "../provider/provider-activity.ts";
import {
  CatalogCapabilityIncompatible,
  CatalogCredentialsUnavailable,
  CatalogDatabaseUnavailable,
  CatalogProviderStale,
} from "./catalog-import-model.ts";
import type { CatalogProviderAccessFailure } from "./catalog-import-model.ts";

const INITIAL_RETRY_MILLISECONDS = 5000;
const MAXIMUM_RETRY_MILLISECONDS = 300_000;
const MAXIMUM_BACKOFF_EXPONENT = 16;
const EXPONENTIAL_FACTOR = 2;
const ZERO = 0;
const ONE = 1;
const RPC_FAILURES: Readonly<Partial<Record<Code, ClassifiedCatalogFailure>>> = {
  [Code.Aborted]: { reason: "plugin_unavailable", retryable: true },
  [Code.Canceled]: { reason: "plugin_unavailable", retryable: true },
  [Code.DeadlineExceeded]: { reason: "plugin_unavailable", retryable: true },
  [Code.FailedPrecondition]: { reason: "capability_incompatible", retryable: false },
  [Code.PermissionDenied]: { reason: "authentication_failed", retryable: false },
  [Code.ResourceExhausted]: { reason: "plugin_unavailable", retryable: true },
  [Code.Unauthenticated]: { reason: "authentication_failed", retryable: false },
  [Code.Unimplemented]: { reason: "capability_incompatible", retryable: false },
};

interface ClassifiedCatalogFailure {
  readonly reason: CatalogScanFailureReason;
  readonly retryAfterMilliseconds?: number;
  readonly retryable: boolean;
}
const pluginRpcFailureWithoutRetryInfo = (
  failure: InstanceType<typeof PluginRpcError>,
): ClassifiedCatalogFailure => {
  if (failure.code === Code.Unavailable) {
    return { reason: "provider_unavailable", retryable: true };
  }
  return RPC_FAILURES[failure.code] ?? { reason: "invalid_response", retryable: false };
};

const classifyPluginRpcFailure = (
  failure: InstanceType<typeof PluginRpcError>,
): ClassifiedCatalogFailure => {
  const classified = pluginRpcFailureWithoutRetryInfo(failure);
  if (!classified.retryable || failure.retryAfterMilliseconds === undefined) {
    return classified;
  }
  return {
    ...classified,
    retryAfterMilliseconds: failure.retryAfterMilliseconds,
  };
};

type CatalogFailure = CatalogProviderAccessFailure | ProviderInstanceBusyFailure;
type FixedClassification = ClassifiedCatalogFailure | "ignore";

const FIXED_FAILURES: ReadonlyMap<object, FixedClassification> = new Map<
  object,
  FixedClassification
>([
  [CatalogCapabilityIncompatible, { reason: "capability_incompatible", retryable: false }],
  [CatalogCredentialsUnavailable, { reason: "credentials_unavailable", retryable: false }],
  [CatalogDatabaseUnavailable, { reason: "database_unavailable", retryable: true }],
  [CatalogProviderStale, "ignore"],
  [PluginDeadlineExceeded, { reason: "plugin_unavailable", retryable: true }],
  [PluginUnavailable, { reason: "plugin_unavailable", retryable: true }],
  [ProviderInstanceBusy, "ignore"],
]);

const classifyCatalogFailure = (failure: CatalogFailure): ClassifiedCatalogFailure | undefined => {
  if (failure instanceof PluginRpcError) {
    return classifyPluginRpcFailure(failure);
  }
  const classified = FIXED_FAILURES.get(failure.constructor);
  if (classified === "ignore") {
    return undefined;
  }
  return classified ?? { reason: "invalid_response", retryable: false };
};
const isInvalidContinuationFailure = (failure: CatalogFailure): boolean =>
  failure instanceof PluginRpcError && failure.code === Code.InvalidArgument;

const retryDelayMilliseconds = (
  failureCount: number,
  retryAfterMilliseconds: number | undefined,
  random: () => number,
): number => {
  const exponent = Math.min(failureCount, MAXIMUM_BACKOFF_EXPONENT);
  const lowerBound = Math.min(
    INITIAL_RETRY_MILLISECONDS * EXPONENTIAL_FACTOR ** exponent,
    MAXIMUM_RETRY_MILLISECONDS,
  );
  const upperBound = Math.min(lowerBound * EXPONENTIAL_FACTOR, MAXIMUM_RETRY_MILLISECONDS);
  const randomFraction = Math.min(Math.max(random(), ZERO), ONE - Number.EPSILON);
  const jittered = lowerBound + Math.floor((upperBound - lowerBound) * randomFraction);
  return Math.max(jittered, retryAfterMilliseconds ?? ZERO);
};

export { classifyCatalogFailure, isInvalidContinuationFailure, retryDelayMilliseconds };
export type { CatalogFailure, ClassifiedCatalogFailure };
