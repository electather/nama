import type { Code, ConnectError } from "@connectrpc/connect";
import { RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { Data } from "effect";

const taggedError = Data.TaggedError;
const ZERO = 0;
const ZERO_SECONDS = 0n;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

type PluginUnavailableReason =
  | "authentication_failed"
  | "contract_unsupported"
  | "descriptor_invalid"
  | "executable_invalid"
  | "handshake_failed"
  | "launch_document_invalid"
  | "launch_protocol_rejected"
  | "plugin_exited"
  | "provider_type_mismatch"
  | "socket_invalid";

type EmptyTaggedErrorFields = Readonly<Record<never, never>>;

const PluginUnavailable = taggedError("PluginUnavailable")<{
  readonly reason: PluginUnavailableReason;
}>;
const PluginDeadlineExceeded = taggedError("PluginDeadlineExceeded")<EmptyTaggedErrorFields>;
const PluginRpcError = taggedError("PluginRpcError")<{
  readonly code: Code;
  readonly retryAfterMilliseconds?: number;
}>;
const PluginSupervisorBoundaryError = taggedError(
  "PluginSupervisorBoundaryError",
)<EmptyTaggedErrorFields>;
const PluginSupervisorCleanupError = taggedError(
  "PluginSupervisorCleanupError",
)<EmptyTaggedErrorFields>;

type PluginUnavailableFailure = InstanceType<typeof PluginUnavailable>;
type PluginDeadlineFailure = InstanceType<typeof PluginDeadlineExceeded>;
type PluginRpcFailure = InstanceType<typeof PluginRpcError>;
type PluginSupervisorBoundaryFailure = InstanceType<typeof PluginSupervisorBoundaryError>;
type PluginSupervisorCleanupFailure = InstanceType<typeof PluginSupervisorCleanupError>;

const retryAfterMillisecondsFrom = (error: ConnectError): number | undefined => {
  try {
    const retryDelay = error.findDetails(RetryInfoSchema).at(ZERO)?.retryDelay;
    if (
      retryDelay === undefined ||
      retryDelay.seconds < ZERO_SECONDS ||
      retryDelay.nanos < ZERO ||
      retryDelay.nanos >= NANOSECONDS_PER_MILLISECOND * MILLISECONDS_PER_SECOND
    ) {
      return undefined;
    }
    const milliseconds =
      Number(retryDelay.seconds) * MILLISECONDS_PER_SECOND +
      Math.ceil(retryDelay.nanos / NANOSECONDS_PER_MILLISECOND);
    if (Number.isSafeInteger(milliseconds)) {
      return milliseconds;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const unavailable = (reason: PluginUnavailableReason): PluginUnavailableFailure =>
  new PluginUnavailable({ reason });

export {
  PluginDeadlineExceeded,
  PluginRpcError,
  PluginSupervisorBoundaryError,
  PluginSupervisorCleanupError,
  PluginUnavailable,
  unavailable,
  retryAfterMillisecondsFrom,
};
export type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginSupervisorBoundaryFailure,
  PluginSupervisorCleanupFailure,
  PluginUnavailableFailure,
  PluginUnavailableReason,
};
