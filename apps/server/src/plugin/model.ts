import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import type { Effect, Scope } from "effect";

import type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginUnavailableFailure,
} from "./errors.ts";
import type { PluginStderrEventDeclaration } from "./stderr.ts";

type PluginLaunch =
  | Readonly<{
      readonly configuration: Readonly<Record<string, unknown>>;
      readonly credentials: Readonly<Record<string, string>>;
      readonly kind: "candidate";
    }>
  | Readonly<{ readonly kind: "discovery" }>
  | Readonly<{
      readonly configuration: Readonly<Record<string, unknown>>;
      readonly credentials: Readonly<Record<string, string>>;
      readonly kind: "instance";
      readonly providerInstanceId: string;
      readonly revision: string;
    }>;

type PreparedPluginLaunch =
  | Readonly<{
      readonly documentContext: string;
      readonly kind: "candidate";
    }>
  | Readonly<{
      readonly documentContext: string;
      readonly kind: "discovery";
    }>
  | Readonly<{
      readonly documentContext: string;
      readonly kind: "instance";
      readonly providerInstanceId: string;
      readonly revision: string;
    }>;

interface PluginLaunchDescriptor {
  readonly arguments: readonly string[];
  readonly executable: string;
  readonly expectedProviderType: string;
  readonly stderrEvents: readonly PluginStderrEventDeclaration[];
}

type PluginCallFailure = PluginDeadlineFailure | PluginRpcFailure | PluginUnavailableFailure;

interface SupervisedPlugin {
  readonly call: <Input extends DescMessage, Output extends DescMessage>(
    method: DescMethodUnary<Input, Output>,
    request: MessageInitShape<Input>,
    deadlineMilliseconds: number,
  ) => Effect.Effect<MessageShape<Output>, PluginCallFailure>;
}

interface PluginSupervisorService {
  readonly supervise: (
    descriptor: PluginLaunchDescriptor,
    launch: PluginLaunch,
  ) => Effect.Effect<SupervisedPlugin, PluginUnavailableFailure, Scope.Scope>;
  readonly retireInstance: (
    providerInstanceId: string,
  ) => Effect.Effect<void, PluginUnavailableFailure>;
}

interface PluginSupervisorLayerOptions {
  readonly effectiveUserId?: number;
  readonly temporaryDirectory?: string;
  readonly spawnProcess?: typeof spawn;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningPlugin {
  readonly bearer: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly launchDirectory: string;
  readonly socketPath: string;
  readonly transport: Transport;
  requestedStop: boolean;
}

interface AcquiredPluginProcess {
  readonly document: string;
  readonly launched: Promise<void>;
  readonly plugin: RunningPlugin;
}

type PluginSpawnProcess = typeof spawn | undefined;

type PluginLogEmitter = (effect: Effect.Effect<void>) => void;

export type {
  AcquiredPluginProcess,
  PluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorLayerOptions,
  PluginCallFailure,
  PluginSupervisorService,
  PreparedPluginLaunch,
  ProcessExit,
  RunningPlugin,
  SupervisedPlugin,
};
