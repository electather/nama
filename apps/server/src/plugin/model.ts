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
  PluginSupervisorCleanupFailure,
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
interface PluginCleanupTarget {
  readonly cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>;
  readonly owner: symbol;
}
interface PluginCleanupOwnership {
  target: PluginCleanupTarget | undefined;
}
type PluginLifecycleState =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "closed" }>
  | Readonly<{
      readonly completion: Deferred.Deferred<RunningPlugin, PluginUnavailableFailure>;
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovering";
      readonly owner: symbol;
      readonly ownership: PluginCleanupOwnership;
      readonly prior: RunningPlugin | typeof ABSENT_PLUGIN;
    }>
  | Readonly<{
      readonly completion: Deferred.Deferred<void, PluginUnavailableFailure>;
      readonly fiber: Fiber.Fiber<void>;
      readonly kind: "retiring";
      readonly owner: symbol;
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{
      readonly failure: PluginUnavailableFailure;
      readonly kind: "retirement_failed";
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{ readonly kind: "ready"; readonly plugin: RunningPlugin }>
  | Readonly<{
      readonly failure: PluginUnavailableFailure;
      readonly kind: "terminal";
      readonly plugin: RunningPlugin | typeof ABSENT_PLUGIN;
    }>;

interface PluginHandleState {
  admission:
    | Readonly<{ readonly kind: "open" }>
    | Readonly<{
        readonly drained: Deferred.Deferred<void>;
        readonly kind: "closed";
      }>;
  activeDemand: number;
  idleTimer:
    | Readonly<{
        readonly fiber: Fiber.Fiber<void>;
        readonly owner: symbol;
      }>
    | undefined;
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
  PluginCleanupOwnership,
  PluginCleanupTarget,
  PluginHandleState,
  PluginLaunch,
  PluginLaunchDescriptor,
  PluginLifecycleState,
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
