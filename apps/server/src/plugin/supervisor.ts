// oxlint-disable import/max-dependencies, eslint/max-lines, eslint/max-lines-per-function, eslint/max-params, eslint/max-statements -- The supervisor is one cohesive process lifecycle state machine; splitting transitions would hide invariants.
// oxlint-disable eslint/no-await-in-loop, eslint/no-magic-numbers, eslint/no-ternary, eslint/no-underscore-dangle, eslint/prefer-destructuring, unicorn/max-nested-calls -- Protocol values and state transitions remain explicit.
// oxlint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Node process events and Effect transformations require callback/combinator APIs.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import type { PluginInfo } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Context, Data, Effect, Exit, Fiber, FiberSet, Layer, Semaphore } from "effect";
import type { Scope } from "effect";

import type { EventMessage } from "../logging/record.ts";
import { makePluginStderrParser } from "./stderr.ts";
import type { AcceptedPluginStderrRecord, PluginStderrEventDeclaration } from "./stderr.ts";

const contextService = Context.Service;
const taggedError = Data.TaggedError;

const CONTRACT_MAJOR = 1;
const ENVELOPE_VERSION = 1;
const HANDSHAKE_TIMEOUT_MILLISECONDS = 5000;
const CONNECT_TIMEOUT_SLACK_MILLISECONDS = 100;
const LAUNCH_PROTOCOL_REJECTION_EXIT_CODE = 64;
const MAXIMUM_ENVELOPE_BYTES = 4096;
const MAXIMUM_SOCKET_PATH_BYTES = 100;
const PROCESS_TERMINATION_TIMEOUT_MILLISECONDS = 2000;
const RECOVERY_DELAYS_MILLISECONDS = [0, 100, 500] as const;
const HEALTHY_EPISODE_RESET_MILLISECONDS = 60_000;
const SOCKET_FILENAME = "p.sock";
const SAFE_PLUGIN_IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/u;
const SAFE_PLUGIN_ENUM_VALUE = /^[A-Za-z0-9._:-]{1,64}$/u;
const ABSENT_PATH = Symbol("absent-path");
const ABSENT_PLUGIN = Symbol("absent-plugin");
const RESERVED_PLUGIN_LOG_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  connect_code: true,
  duration_ms: true,
  error_tag: true,
  event: true,
  exit_code: true,
  level: true,
  provider_instance_id: true,
  provider_type: true,
  recovery_attempt: true,
  request_id: true,
  rpc_method: true,
  sanitized_stack_frames: true,
  signal: true,
  timestamp: true,
});

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

const PluginUnavailable = taggedError("PluginUnavailable")<{
  readonly reason: PluginUnavailableReason;
}>;
type EmptyTaggedErrorFields = Readonly<Record<never, never>>;
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

type PluginLogEmitter = (effect: Effect.Effect<void>) => void;

const pluginLogMessage = (
  descriptor: PluginLaunchDescriptor,
  event: string,
  pluginFields?: Readonly<Record<string, number | string>>,
): EventMessage => ({
  event,
  ...(pluginFields === undefined ? {} : { pluginFields }),
  ...(descriptor.providerInstanceId === undefined
    ? {}
    : { providerInstanceId: descriptor.providerInstanceId }),
  providerType: descriptor.expectedProviderType,
});

const pluginLifecycleMessage = (
  descriptor: PluginLaunchDescriptor,
  event: string,
  fields: Readonly<Pick<EventMessage, "exitCode" | "recoveryAttempt" | "signal">> = {},
): EventMessage => ({
  ...pluginLogMessage(descriptor, event),
  ...fields,
});

const emitPluginStderrRecord = (
  emit: PluginLogEmitter,
  descriptor: PluginLaunchDescriptor,
  record: AcceptedPluginStderrRecord,
): void => {
  const message = pluginLogMessage(descriptor, record.event, record.fields);
  switch (record.level) {
    case "debug": {
      emit(Effect.logDebug(message));
      return;
    }
    case "error": {
      emit(Effect.logError(message));
      return;
    }
    case "info": {
      emit(Effect.logInfo(message));
      return;
    }
    case "warn": {
      emit(Effect.logWarning(message));
    }
  }
};

const unavailable = (reason: PluginUnavailableReason): PluginUnavailableFailure =>
  new PluginUnavailable({ reason });

const removePath = (path: string): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.tryPromise({
    catch: (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return ABSENT_PATH;
      }
      return new PluginSupervisorCleanupError(undefined);
    },
    try: () => rm(path, { recursive: true }),
  }).pipe(Effect.catch((error) => (error === ABSENT_PATH ? Effect.void : Effect.fail(error))));

const makeRuntimeRoot = (
  temporaryDirectory: string,
): Effect.Effect<string, PluginSupervisorBoundaryFailure> =>
  Effect.tryPromise({
    catch: () => new PluginSupervisorBoundaryError(undefined),
    try: async () => {
      const root = await mkdtemp(join(temporaryDirectory, "nama-plugin-"));
      try {
        await chmod(root, 0o700);
        const maximumSocketPath = join(root, "p-XXXXXX", SOCKET_FILENAME);
        if (Buffer.byteLength(maximumSocketPath, "utf8") > MAXIMUM_SOCKET_PATH_BYTES) {
          throw new PluginSupervisorBoundaryError(undefined);
        }
        return root;
      } catch (error) {
        await rm(root, { force: true, recursive: true });
        throw error;
      }
    },
  });

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidEnumValues = (value: unknown): boolean =>
  isUnknownArray(value) &&
  value.length > 0 &&
  value.every(
    (candidate, index, values) =>
      typeof candidate === "string" &&
      SAFE_PLUGIN_ENUM_VALUE.test(candidate) &&
      values.indexOf(candidate) === index,
  );

const isValidStderrField = (fieldName: string, field: unknown): boolean => {
  if (
    !SAFE_PLUGIN_IDENTIFIER.test(fieldName) ||
    RESERVED_PLUGIN_LOG_FIELDS[fieldName] === true ||
    !isUnknownRecord(field)
  ) {
    return false;
  }
  const kind = field["kind"];
  if (kind === "number") {
    return Object.keys(field).length === 1;
  }
  return kind === "enum" && Object.keys(field).length === 2 && isValidEnumValues(field["values"]);
};

const isValidStderrEvent = (value: unknown, eventNames: Set<string>): boolean => {
  if (!isUnknownRecord(value)) {
    return false;
  }
  const event = value["event"];
  const fields = value["fields"];
  if (
    typeof event !== "string" ||
    !SAFE_PLUGIN_IDENTIFIER.test(event) ||
    eventNames.has(event) ||
    !isUnknownRecord(fields) ||
    !Object.entries(fields).every(([fieldName, field]) => isValidStderrField(fieldName, field))
  ) {
    return false;
  }
  eventNames.add(event);
  return true;
};

const isValidDescriptor = (descriptor: PluginLaunchDescriptor): boolean => {
  const argumentsValue: unknown = descriptor.arguments;
  const stderrEventsValue: unknown = descriptor.stderrEvents;
  if (
    !isUnknownArray(argumentsValue) ||
    !argumentsValue.every((argument) => typeof argument === "string" && !argument.includes("\0")) ||
    typeof descriptor.expectedProviderType !== "string" ||
    !SAFE_PLUGIN_IDENTIFIER.test(descriptor.expectedProviderType) ||
    (descriptor.providerInstanceId !== undefined &&
      (typeof descriptor.providerInstanceId !== "string" ||
        !SAFE_PLUGIN_IDENTIFIER.test(descriptor.providerInstanceId))) ||
    !isUnknownArray(stderrEventsValue)
  ) {
    return false;
  }
  const eventNames = new Set<string>();
  return stderrEventsValue.every((value) => isValidStderrEvent(value, eventNames));
};

const validateDescriptor = (
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<void, PluginUnavailableFailure> =>
  isValidDescriptor(descriptor) ? Effect.void : Effect.fail(unavailable("descriptor_invalid"));

const validateExecutable = (
  executable: string,
  effectiveUserId: number | undefined,
): Effect.Effect<void, PluginUnavailableFailure> => {
  if (!isAbsolute(executable)) {
    return Effect.fail(unavailable("executable_invalid"));
  }
  return Effect.tryPromise({
    catch: () => unavailable("executable_invalid"),
    try: async () => {
      const executableStat = await lstat(executable);
      const validOwner =
        executableStat.uid === 0 ||
        (effectiveUserId !== undefined && executableStat.uid === effectiveUserId);
      const unsafeMode = (executableStat.mode & 0o022) !== 0;
      if (
        !executableStat.isFile() ||
        executableStat.isSymbolicLink() ||
        !validOwner ||
        unsafeMode
      ) {
        throw new Error("invalid executable");
      }
      await access(executable, constants.X_OK);
    },
  });
};

const makeLaunchDirectory = (
  runtimeRoot: string,
): Effect.Effect<string, PluginUnavailableFailure> =>
  Effect.tryPromise({
    catch: () => unavailable("socket_invalid"),
    try: async () => {
      const launchDirectory = await mkdtemp(join(runtimeRoot, "p-"));
      try {
        await chmod(launchDirectory, 0o700);
        return launchDirectory;
      } catch (error) {
        await rm(launchDirectory, { force: true, recursive: true });
        throw error;
      }
    },
  });

const spawnFailure = (error: unknown): PluginUnavailableFailure => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return unavailable("executable_invalid");
  }
  return unavailable(
    error.code === "EAGAIN" || error.code === "ENOMEM" ? "plugin_exited" : "executable_invalid",
  );
};

const spawnBundledPlugin = (descriptor: PluginLaunchDescriptor): ChildProcessWithoutNullStreams =>
  // fallow-ignore-next-line security-sink -- The descriptor is code-owned, the executable path is validated before this call, and spawn does not invoke a shell.
  spawn(descriptor.executable, [...descriptor.arguments], {
    detached: true,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });

const acquirePluginProcess = (
  descriptor: PluginLaunchDescriptor,
  launchDirectory: string,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<AcquiredPluginProcess, PluginUnavailableFailure> =>
  Effect.gen(function* acquirePluginProcessEffect() {
    const bearer = randomBytes(32).toString("base64url");
    const socketPath = join(launchDirectory, SOCKET_FILENAME);
    const envelope = JSON.stringify({
      bearer,
      socket_path: socketPath,
      version: ENVELOPE_VERSION,
    });
    if (
      Buffer.byteLength(socketPath, "utf8") > MAXIMUM_SOCKET_PATH_BYTES ||
      Buffer.byteLength(envelope, "utf8") > MAXIMUM_ENVELOPE_BYTES
    ) {
      return yield* Effect.fail(unavailable("socket_invalid"));
    }
    const transport = createConnectTransport({
      baseUrl: "http://localhost",
      httpVersion: "1.1",
      nodeOptions: { socketPath },
    });
    const launched = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<ProcessExit>();
    const child = yield* Effect.try({
      catch: spawnFailure,
      try: () => {
        const spawned =
          spawnProcess === undefined
            ? spawnBundledPlugin(descriptor)
            : spawnProcess(descriptor.executable, [...descriptor.arguments], {
                detached: true,
                env: {},
                stdio: ["pipe", "pipe", "pipe"],
              });
        let didSpawn = false;
        spawned.on("error", (error) => {
          if (!didSpawn) {
            launched.reject(error);
            exited.resolve({ code: spawned.exitCode, signal: spawned.signalCode });
          }
        });
        spawned.once("spawn", () => {
          didSpawn = true;
          launched.resolve();
        });
        spawned.once("exit", (code, signal) => {
          exited.resolve({ code, signal });
        });
        return spawned;
      },
    });
    return {
      envelope,
      launched: launched.promise,
      plugin: {
        bearer,
        child,
        exit: exited.promise,
        launchDirectory,
        requestedStop: false,
        socketPath,
        transport,
      },
    };
  });

const writeLaunchEnvelope = (
  plugin: RunningPlugin,
  envelope: string,
): Effect.Effect<void, PluginUnavailableFailure> =>
  Effect.callback((resume) => {
    const onError = (): void => {
      cleanup();
      resume(Effect.fail(unavailable("plugin_exited")));
    };
    const onWritten = (): void => {
      cleanup();
      resume(Effect.void);
    };
    const cleanup = (): void => {
      plugin.child.stdin.removeListener("error", onError);
    };
    plugin.child.stdin.once("error", onError);
    plugin.child.stdin.end(envelope, "utf8", onWritten);
    return Effect.sync(cleanup);
  });

const finishPluginStartup = (
  acquired: AcquiredPluginProcess,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  Effect.gen(function* finishPluginStartupEffect() {
    yield* Effect.tryPromise({
      catch: spawnFailure,
      try: () => acquired.launched,
    });
    acquired.plugin.child.stdout.resume();
    const stderrParser = makePluginStderrParser(descriptor.stderrEvents, {
      accepted: (record) => {
        emitPluginStderrRecord(emit, descriptor, record);
      },
      dropped: () => {
        emit(Effect.logWarning(pluginLogMessage(descriptor, "plugin.stderr_dropped")));
      },
    });
    acquired.plugin.child.stderr.on("data", (chunk: Buffer) => {
      stderrParser.write(chunk);
    });
    yield* writeLaunchEnvelope(acquired.plugin, acquired.envelope);
    return acquired.plugin;
  });

const authenticatedHeaders = (bearer: string): Headers => {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${bearer}`);
  return headers;
};

const runUnary = <Input extends DescMessage, Output extends DescMessage>(
  plugin: RunningPlugin,
  method: DescMethodUnary<Input, Output>,
  request: MessageInitShape<Input>,
  deadlineMilliseconds: number,
) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: (signal) =>
      plugin.transport.unary(
        method,
        signal,
        deadlineMilliseconds + CONNECT_TIMEOUT_SLACK_MILLISECONDS,
        authenticatedHeaders(plugin.bearer),
        request,
      ),
  }).pipe(Effect.map((response) => response.message));

const waitForSocket = (socketPath: string): Effect.Effect<void, PluginUnavailableFailure> =>
  Effect.tryPromise({
    catch: () => unavailable("socket_invalid"),
    try: async (signal) => {
      while (!signal.aborted) {
        try {
          const socketStat = await lstat(socketPath);
          if (!socketStat.isSocket() || (socketStat.mode & 0o777) !== 0o600) {
            throw new Error("invalid socket");
          }
          return;
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        const delay = Promise.withResolvers<void>();
        setTimeout(delay.resolve, 5);
        await delay.promise;
      }
      throw new Error("aborted");
    },
  });

const handshakeFailure = (error: unknown): PluginUnavailableFailure =>
  ConnectError.from(error).code === Code.Unauthenticated
    ? unavailable("authentication_failed")
    : unavailable("handshake_failed");

const runHandshakeUnary = <Input extends DescMessage, Output extends DescMessage>(
  plugin: RunningPlugin,
  method: DescMethodUnary<Input, Output>,
  request: MessageInitShape<Input>,
): Effect.Effect<MessageShape<Output>, PluginUnavailableFailure> =>
  runUnary(plugin, method, request, HANDSHAKE_TIMEOUT_MILLISECONDS).pipe(
    Effect.mapError(handshakeFailure),
  );

const performHandshake = (
  plugin: RunningPlugin,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<PluginInfo, PluginUnavailableFailure> =>
  Effect.gen(function* pluginHandshake() {
    yield* waitForSocket(plugin.socketPath);
    const health = yield* runHandshakeUnary(plugin, HealthService.method.check, {});
    if (health.status !== ServingStatus.SERVING) {
      return yield* Effect.fail(unavailable("handshake_failed"));
    }

    const response = yield* runHandshakeUnary(plugin, PluginService.method.getInfo, {});
    const info = response.pluginInfo;
    if (info === undefined) {
      return yield* Effect.fail(unavailable("handshake_failed"));
    }
    if (info.providerTypeId !== descriptor.expectedProviderType) {
      return yield* Effect.fail(unavailable("provider_type_mismatch"));
    }
    if (info.contractMajor !== CONTRACT_MAJOR) {
      return yield* Effect.fail(unavailable("contract_unsupported"));
    }
    return info;
  });

const signalProcessGroup = (plugin: RunningPlugin, signal: NodeJS.Signals): void => {
  const processId = plugin.child.pid;
  if (processId === undefined) {
    return;
  }
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
};

const processGroupExited = (processId: number): boolean => {
  try {
    process.kill(-processId, 0);
    return false;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      throw error;
    }
    if (error.code === "ESRCH") {
      return true;
    }
    if (error.code === "EPERM") {
      return false;
    }
    throw error;
  }
};

const awaitProcessGroupExit = (
  plugin: RunningPlugin,
): Effect.Effect<void, PluginSupervisorCleanupFailure> => {
  const processId = plugin.child.pid;
  if (processId === undefined) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: () => new PluginSupervisorCleanupError(undefined),
    try: async (signal) => {
      while (!signal.aborted && !processGroupExited(processId)) {
        const nextTurn = Promise.withResolvers<void>();
        setImmediate(nextTurn.resolve);
        await nextTurn.promise;
      }
    },
  });
};

const stopPlugin = (plugin: RunningPlugin): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.gen(function* stopPluginProcess() {
    plugin.requestedStop = true;
    yield* Effect.try({
      catch: () => new PluginSupervisorCleanupError(undefined),
      try: () => {
        signalProcessGroup(plugin, "SIGTERM");
      },
    });
    const groupExited = yield* Effect.raceFirst(
      awaitProcessGroupExit(plugin).pipe(Effect.as(true)),
      Effect.sleep(PROCESS_TERMINATION_TIMEOUT_MILLISECONDS).pipe(Effect.as(false)),
    );
    if (!groupExited) {
      yield* Effect.try({
        catch: () => new PluginSupervisorCleanupError(undefined),
        try: () => {
          signalProcessGroup(plugin, "SIGKILL");
        },
      });
    }
    yield* Effect.all([Effect.promise(() => plugin.exit), awaitProcessGroupExit(plugin)] as const, {
      concurrency: "unbounded",
    });
    yield* removePath(plugin.launchDirectory);
  });

const launchPlugin = (
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* launchPluginProcess() {
      const launchDirectory = yield* makeLaunchDirectory(runtimeRoot);
      const acquired = yield* acquirePluginProcess(descriptor, launchDirectory, spawnProcess).pipe(
        Effect.onError(() => removePath(launchDirectory).pipe(Effect.orDie)),
      );
      const launchedPlugin = acquired.plugin;
      const attempt = Effect.gen(function* launchAttempt() {
        yield* finishPluginStartup(acquired, descriptor, emit);
        yield* Effect.raceFirst(
          performHandshake(launchedPlugin, descriptor),
          Effect.raceFirst(
            Effect.promise(() => launchedPlugin.exit).pipe(
              Effect.flatMap((processExit) =>
                Effect.fail(
                  unavailable(
                    processExit.code === LAUNCH_PROTOCOL_REJECTION_EXIT_CODE
                      ? "launch_protocol_rejected"
                      : "plugin_exited",
                  ),
                ),
              ),
            ),
            Effect.sleep(HANDSHAKE_TIMEOUT_MILLISECONDS).pipe(
              Effect.andThen(Effect.fail(unavailable("handshake_failed"))),
            ),
          ),
        );
        return launchedPlugin;
      });
      return yield* restore(attempt).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : stopPlugin(launchedPlugin).pipe(Effect.orDie),
        ),
      );
    }),
  );

interface RecoveryResult {
  readonly launchesInEpisode: number;
  readonly plugin: RunningPlugin;
}

const failureMayRecoverOnFreshProcess = (failure: PluginUnavailableFailure): boolean =>
  failure.reason === "handshake_failed" || failure.reason === "plugin_exited";

const recoverPlugin = (
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  priorLaunches: number,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<RecoveryResult, PluginUnavailableFailure> =>
  Effect.gen(function* recoverPluginProcess() {
    let launchesInEpisode = priorLaunches;
    let lastFailure = unavailable("plugin_exited");
    while (launchesInEpisode < RECOVERY_DELAYS_MILLISECONDS.length) {
      emit(
        Effect.logInfo(
          pluginLifecycleMessage(descriptor, "plugin.recovery_attempt", {
            recoveryAttempt: launchesInEpisode + 1,
          }),
        ),
      );
      const delay = RECOVERY_DELAYS_MILLISECONDS[launchesInEpisode];
      if (delay !== undefined && delay > 0) {
        yield* Effect.sleep(delay);
      }
      launchesInEpisode += 1;
      const outcome = yield* launchPlugin(runtimeRoot, descriptor, emit, spawnProcess).pipe(
        Effect.match({
          onFailure: (failure) => ({ failure, success: false as const }),
          onSuccess: (plugin) => ({ plugin, success: true as const }),
        }),
      );
      if (outcome.success) {
        return { launchesInEpisode, plugin: outcome.plugin };
      }
      lastFailure = outcome.failure;
      if (!failureMayRecoverOnFreshProcess(lastFailure)) {
        return yield* Effect.fail(lastFailure);
      }
    }
    emit(
      Effect.logError(
        pluginLifecycleMessage(descriptor, "plugin.recovery_exhausted", {
          recoveryAttempt: launchesInEpisode,
        }),
      ),
    );
    return yield* Effect.fail(lastFailure);
  });

const callPlugin = <Input extends DescMessage, Output extends DescMessage>(
  plugin: RunningPlugin,
  method: DescMethodUnary<Input, Output>,
  request: MessageInitShape<Input>,
  deadlineMilliseconds: number,
): Effect.Effect<MessageShape<Output>, PluginRpcFailure | PluginUnavailableFailure> =>
  runUnary(plugin, method, request, deadlineMilliseconds).pipe(
    Effect.mapError((error) => {
      const connectError = ConnectError.from(error);
      return connectError.cause === undefined
        ? new PluginRpcError({ code: connectError.code })
        : unavailable("plugin_exited");
    }),
  );

const forkPluginRecovery = (
  state: PluginHandleState,
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  graceMilliseconds: number,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>> =>
  Effect.gen(function* forkPluginRecoveryProcess() {
    state.unhealthy = true;
    const processToReplace = state.current;
    const stopPriorProcess =
      processToReplace === ABSENT_PLUGIN
        ? Effect.void
        : Effect.sleep(graceMilliseconds).pipe(Effect.andThen(stopPlugin(processToReplace)));
    const recovery = stopPriorProcess.pipe(
      Effect.mapError(() => unavailable("plugin_exited")),
      Effect.andThen(
        recoverPlugin(runtimeRoot, descriptor, state.launchesInEpisode, emit, spawnProcess),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          state.current = result.plugin;
          state.launchesInEpisode = result.launchesInEpisode;
          state.unhealthy = false;
        }).pipe(
          Effect.andThen(
            Effect.all(
              [
                forkPluginExitWatcher(
                  state,
                  runtimeRoot,
                  descriptor,
                  result.plugin,
                  emit,
                  spawnProcess,
                ),
                forkHealthyEpisodeReset(state, result.plugin),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
      ),
      Effect.map((result) => result.plugin),
      Effect.tapError((failure) =>
        Effect.sync(() => {
          state.terminal = failure;
        }),
      ),
      Effect.onExit(() =>
        Effect.sync(() => {
          state.recoveryFiber = undefined;
        }),
      ),
    );
    const fiber = yield* Effect.forkIn(recovery, state.scope);
    state.recoveryFiber = fiber;
    return fiber;
  });

const beginPluginRecovery = (
  state: PluginHandleState,
  recoveryLock: Semaphore.Semaphore,
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  plugin: RunningPlugin,
  graceMilliseconds: number,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<void> =>
  recoveryLock.withPermits(1)(
    Effect.suspend(() => {
      if (
        state.terminal !== undefined ||
        state.current !== plugin ||
        state.recoveryFiber !== undefined
      ) {
        return Effect.void;
      }
      return forkPluginRecovery(
        state,
        runtimeRoot,
        descriptor,
        graceMilliseconds,
        emit,
        spawnProcess,
      ).pipe(Effect.asVoid);
    }),
  );

const forkPluginExitWatcher = (
  state: PluginHandleState,
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  plugin: RunningPlugin,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<void> =>
  Effect.promise(() => plugin.exit).pipe(
    Effect.flatMap((processExit) => {
      if (plugin.requestedStop) {
        return Effect.void;
      }
      emit(
        Effect.logWarning(
          pluginLifecycleMessage(descriptor, "plugin.process_exited", {
            ...(processExit.code === null ? {} : { exitCode: processExit.code }),
            ...(processExit.signal === null ? {} : { signal: processExit.signal }),
          }),
        ),
      );
      const recoveryLock = state.recoveryLock;
      return beginPluginRecovery(
        state,
        recoveryLock,
        runtimeRoot,
        descriptor,
        plugin,
        0,
        emit,
        spawnProcess,
      );
    }),
    Effect.forkIn(state.scope),
    Effect.asVoid,
  );

const forkHealthyEpisodeReset = (
  state: PluginHandleState,
  plugin: RunningPlugin,
): Effect.Effect<void> =>
  Effect.sleep(HEALTHY_EPISODE_RESET_MILLISECONDS).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (
          state.current === plugin &&
          !state.unhealthy &&
          state.terminal === undefined &&
          plugin.child.exitCode === null &&
          plugin.child.signalCode === null
        ) {
          state.launchesInEpisode = 0;
        }
      }),
    ),
    Effect.forkIn(state.scope),
    Effect.asVoid,
  );
type RunningPluginSelection =
  | Readonly<{
      readonly _tag: "recovery";
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
    }>
  | Readonly<{ readonly _tag: "ready"; readonly plugin: RunningPlugin }>;

const ensureRunningPlugin = (
  state: PluginHandleState,
  recoveryLock: Semaphore.Semaphore,
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  recoveryLock
    .withPermits(1)(
      Effect.suspend<RunningPluginSelection, PluginUnavailableFailure, never>(() => {
        if (state.closed) {
          return Effect.fail(unavailable("plugin_exited"));
        }
        if (state.terminal !== undefined) {
          return Effect.fail(state.terminal);
        }
        if (state.recoveryFiber !== undefined) {
          return Effect.succeed({
            _tag: "recovery" as const,
            fiber: state.recoveryFiber,
          });
        }
        if (
          state.current !== ABSENT_PLUGIN &&
          !state.unhealthy &&
          state.current.child.exitCode === null &&
          state.current.child.signalCode === null
        ) {
          return Effect.succeed({
            _tag: "ready" as const,
            plugin: state.current,
          });
        }
        return forkPluginRecovery(state, runtimeRoot, descriptor, 0, emit, spawnProcess).pipe(
          Effect.map((fiber) => ({ _tag: "recovery" as const, fiber })),
        );
      }),
    )
    .pipe(
      Effect.flatMap((selection) =>
        selection._tag === "recovery"
          ? Fiber.join(selection.fiber)
          : Effect.succeed(selection.plugin),
      ),
    );

const callSupervisedPlugin = <Input extends DescMessage, Output extends DescMessage>(
  state: PluginHandleState,
  runtimeRoot: string,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
  method: DescMethodUnary<Input, Output>,
  request: MessageInitShape<Input>,
  deadlineMilliseconds: number,
): Effect.Effect<
  MessageShape<Output>,
  PluginDeadlineFailure | PluginRpcFailure | PluginUnavailableFailure
> =>
  Effect.suspend(() => {
    if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= 0) {
      return Effect.fail(new PluginDeadlineExceeded(undefined));
    }
    let selectedPlugin: RunningPlugin | typeof ABSENT_PLUGIN = ABSENT_PLUGIN;
    const operation = ensureRunningPlugin(
      state,
      state.recoveryLock,
      runtimeRoot,
      descriptor,
      emit,
      spawnProcess,
    ).pipe(
      Effect.tap((plugin) =>
        Effect.sync(() => {
          selectedPlugin = plugin;
        }),
      ),
      Effect.flatMap((plugin) => callPlugin(plugin, method, request, deadlineMilliseconds)),
    );
    return Effect.raceFirst(
      operation,
      Effect.sleep(deadlineMilliseconds).pipe(
        Effect.andThen(Effect.fail(new PluginDeadlineExceeded(undefined))),
      ),
    ).pipe(
      Effect.tapError((failure) => {
        if (selectedPlugin === ABSENT_PLUGIN) {
          return Effect.void;
        }
        if (failure._tag === "PluginDeadlineExceeded") {
          emit(
            Effect.logWarning(pluginLifecycleMessage(descriptor, "plugin.rpc_deadline_exceeded")),
          );
          return beginPluginRecovery(
            state,
            state.recoveryLock,
            runtimeRoot,
            descriptor,
            selectedPlugin,
            1000,
            emit,
            spawnProcess,
          );
        }
        if (failure._tag === "PluginUnavailable" && failure.reason === "plugin_exited") {
          return beginPluginRecovery(
            state,
            state.recoveryLock,
            runtimeRoot,
            descriptor,
            selectedPlugin,
            0,
            emit,
            spawnProcess,
          );
        }
        return Effect.void;
      }),
    );
  });

const closePluginHandle = (
  state: PluginHandleState,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.suspend(() => {
    if (state.closed) {
      return Effect.void;
    }
    state.closed = true;
    return Effect.gen(function* closeSupervisedPlugin() {
      if (state.recoveryFiber !== undefined) {
        yield* Fiber.interrupt(state.recoveryFiber);
      }
      if (state.current !== ABSENT_PLUGIN) {
        yield* stopPlugin(state.current);
      }
    });
  });

const makePluginSupervisor = (
  runtimeRoot: string,
  effectiveUserId: number | undefined,
  activeHandles: Set<PluginHandleState>,
  emit: PluginLogEmitter,
  spawnProcess: typeof spawn | undefined,
): PluginSupervisorService =>
  Object.freeze({
    supervise: (descriptor: PluginLaunchDescriptor) =>
      validateDescriptor(descriptor).pipe(
        Effect.andThen(validateExecutable(descriptor.executable, effectiveUserId)),
        Effect.andThen(
          Effect.acquireRelease(
            Effect.gen(function* acquirePluginHandle() {
              const scope = yield* Effect.scope;
              const state: PluginHandleState = {
                closed: false,
                current: ABSENT_PLUGIN,
                launchesInEpisode: 0,
                recoveryFiber: undefined,
                recoveryLock: Semaphore.makeUnsafe(1),
                scope,
                terminal: undefined,
                unhealthy: true,
              };
              activeHandles.add(state);
              yield* forkPluginRecovery(state, runtimeRoot, descriptor, 0, emit, spawnProcess);
              return state;
            }),
            (state) =>
              closePluginHandle(state).pipe(
                Effect.orDie,
                Effect.ensuring(
                  Effect.sync(() => {
                    activeHandles.delete(state);
                  }),
                ),
              ),
          ),
        ),
        Effect.map((state) =>
          Object.freeze({
            call: <CallInput extends DescMessage, CallOutput extends DescMessage>(
              method: DescMethodUnary<CallInput, CallOutput>,
              request: MessageInitShape<CallInput>,
              deadlineMilliseconds: number,
            ) =>
              callSupervisedPlugin(
                state,
                runtimeRoot,
                descriptor,
                emit,
                spawnProcess,
                method,
                request,
                deadlineMilliseconds,
              ),
          }),
        ),
      ),
  });

const makePluginSupervisorLayer = ({
  effectiveUserId = process.geteuid?.(),
  temporaryDirectory = tmpdir(),
  spawnProcess,
}: PluginSupervisorLayerOptions = {}) =>
  Layer.effect(
    PluginSupervisor,
    Effect.gen(function* makePluginSupervisorService() {
      const runtimeRoot = yield* Effect.acquireRelease(
        makeRuntimeRoot(temporaryDirectory),
        (root) => removePath(root).pipe(Effect.orDie),
      );
      const runLogEffect = yield* FiberSet.makeRuntime<never, void, never>();
      const activeHandles = new Set<PluginHandleState>();
      yield* Effect.addFinalizer(() =>
        Effect.forEach(activeHandles, closePluginHandle, {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.orDie),
      );
      const emit: PluginLogEmitter = (effect) => {
        runLogEffect(effect);
      };
      return PluginSupervisor.of(
        makePluginSupervisor(runtimeRoot, effectiveUserId, activeHandles, emit, spawnProcess),
      );
    }),
  );

class PluginSupervisor extends contextService<PluginSupervisor, PluginSupervisorService>()(
  "@nama/server/PluginSupervisor",
) {
  static readonly layer = makePluginSupervisorLayer;
}

export { PluginSupervisor };
export type { PluginStderrEventDeclaration };
