import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import type { Deferred, Effect, Fiber, Scope, Semaphore } from "effect";

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
type PluginLifecycleState =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "closed" }>
  | Readonly<{
      readonly completion: Deferred.Deferred<RunningPlugin, PluginUnavailableFailure>;
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovering";
      readonly owner: symbol;
      readonly prior: RunningPlugin | typeof ABSENT_PLUGIN;
    }>
  | Readonly<{ readonly kind: "ready"; readonly plugin: RunningPlugin }>
  | Readonly<{
      readonly failure: PluginUnavailableFailure;
      readonly kind: "terminal";
      readonly plugin: RunningPlugin | typeof ABSENT_PLUGIN;
    }>;

interface PluginHandleState {
  launchesInEpisode: number;
  lifecycle: PluginLifecycleState;
  readonly lifecycleSemaphore: Semaphore.Semaphore;
  readonly scope: Scope.Scope;
}

type PluginSpawnProcess = typeof spawn | undefined;

type PluginLogEmitter = (effect: Effect.Effect<void>) => void;

const ABSENT_PLUGIN = Symbol("absent-plugin");

export { ABSENT_PLUGIN };
export type {
  AcquiredPluginProcess,
  PluginHandleState,
  PluginLifecycleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorLayerOptions,
  PluginSupervisorService,
  ProcessExit,
  RunningPlugin,
  SupervisedPlugin,
};
