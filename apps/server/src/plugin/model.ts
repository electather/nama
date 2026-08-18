import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import type { Effect, Fiber, Scope, Semaphore } from "effect";

import type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginUnavailableFailure,
} from "./errors.ts";
import type { PluginStderrEventDeclaration } from "./stderr.ts";

interface PluginLaunchDescriptor {
  readonly arguments: readonly string[];
  readonly executable: string;
  readonly expectedProviderType: string;
  readonly providerInstanceId?: string;
  readonly stderrEvents: readonly PluginStderrEventDeclaration[];
}

interface SupervisedPlugin {
  readonly call: <Input extends DescMessage, Output extends DescMessage>(
    method: DescMethodUnary<Input, Output>,
    request: MessageInitShape<Input>,
    deadlineMilliseconds: number,
  ) => Effect.Effect<
    MessageShape<Output>,
    PluginDeadlineFailure | PluginRpcFailure | PluginUnavailableFailure
  >;
}

interface PluginSupervisorService {
  readonly supervise: (
    descriptor: PluginLaunchDescriptor,
  ) => Effect.Effect<SupervisedPlugin, PluginUnavailableFailure, Scope.Scope>;
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
  readonly envelope: string;
  readonly launched: Promise<void>;
  readonly plugin: RunningPlugin;
}

interface PluginHandleState {
  closed: boolean;
  current: RunningPlugin | typeof ABSENT_PLUGIN;
  launchesInEpisode: number;
  readonly recoveryLock: Semaphore.Semaphore;
  recoveryFiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure> | undefined;
  readonly scope: Scope.Scope;
  terminal: PluginUnavailableFailure | undefined;
  unhealthy: boolean;
}

type PluginSpawnProcess = typeof spawn | undefined;

type PluginLogEmitter = (effect: Effect.Effect<void>) => void;

const ABSENT_PLUGIN = Symbol("absent-plugin");

export { ABSENT_PLUGIN };
export type {
  AcquiredPluginProcess,
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorLayerOptions,
  PluginSupervisorService,
  ProcessExit,
  RunningPlugin,
  SupervisedPlugin,
};
