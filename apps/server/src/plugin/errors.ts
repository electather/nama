import type { Code } from "@connectrpc/connect";
import { Data } from "effect";

const taggedError = Data.TaggedError;

type PluginUnavailableReason =
  | "authentication_failed"
  | "contract_unsupported"
  | "descriptor_invalid"
  | "executable_invalid"
  | "handshake_failed"
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

const unavailable = (reason: PluginUnavailableReason): PluginUnavailableFailure =>
  new PluginUnavailable({ reason });

export {
  PluginDeadlineExceeded,
  PluginRpcError,
  PluginSupervisorBoundaryError,
  PluginSupervisorCleanupError,
  PluginUnavailable,
  unavailable,
};
export type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginSupervisorBoundaryFailure,
  PluginSupervisorCleanupFailure,
  PluginUnavailableFailure,
  PluginUnavailableReason,
};
