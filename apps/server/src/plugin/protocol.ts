import { lstat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import type { PluginInfo } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect } from "effect";

import {
  CONNECT_TIMEOUT_SLACK_MILLISECONDS,
  CONTRACT_MAJOR,
  HANDSHAKE_TIMEOUT_MILLISECONDS,
  SOCKET_MODE,
  SOCKET_MODE_MASK,
  SOCKET_POLL_MILLISECONDS,
} from "./constants.ts";
import { PluginRpcError, unavailable } from "./errors.ts";
import type { PluginRpcFailure, PluginUnavailableFailure } from "./errors.ts";
import type { PluginLaunchDescriptor, RunningPlugin } from "./model.ts";

interface UnaryCall<Input extends DescMessage, Output extends DescMessage> {
  readonly deadlineMilliseconds: number;
  readonly method: DescMethodUnary<Input, Output>;
  readonly plugin: RunningPlugin;
  readonly request: MessageInitShape<Input>;
}

const authorizationHeaders = (bearer: string): Headers => {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${bearer}`);
  return headers;
};

const runUnary = <Input extends DescMessage, Output extends DescMessage>({
  deadlineMilliseconds,
  method,
  plugin,
  request,
}: UnaryCall<Input, Output>): Effect.Effect<MessageShape<Output>, ConnectError> =>
  Effect.tryPromise({
    catch: (error) => ConnectError.from(error),
    try: (signal) =>
      plugin.transport.unary(
        method,
        signal,
        deadlineMilliseconds + CONNECT_TIMEOUT_SLACK_MILLISECONDS,
        authorizationHeaders(plugin.bearer),
        request,
      ),
  }).pipe(Effect.map((response) => response.message));

const isSocketAbsentError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return code === "ENOENT";
};

const validateSocket = async (socketPath: string): Promise<void> => {
  const socketStat = await lstat(socketPath);
  if ((socketStat.mode & SOCKET_MODE_MASK) !== SOCKET_MODE || !socketStat.isSocket()) {
    throw new Error("invalid socket");
  }
};

const waitForSocket = async (socketPath: string, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    throw new Error("aborted");
  }
  try {
    await validateSocket(socketPath);
  } catch (error) {
    if (!isSocketAbsentError(error)) {
      throw new Error("socket validation failed", { cause: error });
    }
    await sleep(SOCKET_POLL_MILLISECONDS);
    return waitForSocket(socketPath, signal);
  }
};

const waitForPluginSocket = (socketPath: string): Effect.Effect<void, PluginUnavailableFailure> =>
  Effect.tryPromise({
    catch: () => unavailable("socket_invalid"),
    try: (signal) => waitForSocket(socketPath, signal),
  });

const handshakeFailure = (error: ConnectError): PluginUnavailableFailure => {
  if (error.code === Code.Unauthenticated) {
    return unavailable("authentication_failed");
  }
  return unavailable("handshake_failed");
};

const runHandshakeUnary = <Input extends DescMessage, Output extends DescMessage>(
  plugin: RunningPlugin,
  method: DescMethodUnary<Input, Output>,
  request: MessageInitShape<Input>,
): Effect.Effect<MessageShape<Output>, PluginUnavailableFailure> =>
  runUnary({
    deadlineMilliseconds: HANDSHAKE_TIMEOUT_MILLISECONDS,
    method,
    plugin,
    request,
  }).pipe(Effect.mapError(handshakeFailure));

const validatePluginInfo = (
  info: PluginInfo | undefined,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<PluginInfo, PluginUnavailableFailure> => {
  if (info === undefined) {
    return Effect.fail(unavailable("handshake_failed"));
  }
  if (info.providerTypeId !== descriptor.expectedProviderType) {
    return Effect.fail(unavailable("provider_type_mismatch"));
  }
  if (info.contractMajor !== CONTRACT_MAJOR) {
    return Effect.fail(unavailable("contract_unsupported"));
  }
  return Effect.succeed(info);
};

const performHandshake = (
  plugin: RunningPlugin,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<PluginInfo, PluginUnavailableFailure> =>
  Effect.gen(function* pluginHandshake() {
    yield* waitForPluginSocket(plugin.socketPath);
    const health = yield* runHandshakeUnary(plugin, HealthService.method.check, {});
    if (health.status !== ServingStatus.SERVING) {
      return yield* Effect.fail(unavailable("handshake_failed"));
    }
    const response = yield* runHandshakeUnary(plugin, PluginService.method.getInfo, {});
    return yield* validatePluginInfo(response.pluginInfo, descriptor);
  });

const pluginCallFailure = (error: ConnectError): PluginRpcFailure | PluginUnavailableFailure => {
  if (error.cause === undefined) {
    return new PluginRpcError({ code: error.code });
  }
  return unavailable("plugin_exited");
};

const callPlugin = <Input extends DescMessage, Output extends DescMessage>(
  call: UnaryCall<Input, Output>,
): Effect.Effect<MessageShape<Output>, PluginRpcFailure | PluginUnavailableFailure> =>
  runUnary(call).pipe(Effect.mapError(pluginCallFailure));

export { callPlugin, performHandshake };
export type { UnaryCall };
