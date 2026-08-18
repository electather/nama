// oxlint-disable eslint/func-names, eslint/id-length, eslint/init-declarations, eslint/max-lines, eslint/max-lines-per-function, eslint/max-params, eslint/max-statements, eslint/no-await-in-loop, eslint/no-continue, eslint/no-control-regex, eslint/no-magic-numbers, eslint/no-ternary, eslint/no-underscore-dangle, eslint/require-await, eslint/sort-keys, import/consistent-type-specifier-style, import/exports-last, import/group-exports, import/max-dependencies, import/newline-after-import, node/no-sync, promise/avoid-new, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, typescript/consistent-type-definitions, typescript/consistent-type-imports, typescript/no-unnecessary-type-arguments, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/no-useless-default-assignment, typescript/only-throw-error, typescript/prefer-nullish-coalescing, typescript/strict-boolean-expressions, unicorn/consistent-existence-index-check, unicorn/consistent-function-scoping, unicorn/escape-case, unicorn/max-nested-calls, unicorn/no-array-callback-reference, unicorn/no-null, unicorn/numeric-separators-style -- The supervisor is one cohesive trust-boundary owner; its process, handshake, recovery, and cleanup policies must evolve together.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { DescService } from "@bufbuild/protobuf";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import type { CallOptions, Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { PlaybackService } from "@nama/api/nama/plugin/v1/playback_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { WatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect";

import { logPluginEvent } from "../logging/logging.ts";
const PROTOCOL_VERSION = 1;
const CONTRACT_MAJOR = 1;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEADLINE_CANCELLATION_GRACE_MS = 1_000;
const SHUTDOWN_GRACE_MS = 2_000;
const HEALTHY_RESET_MS = 60_000;
const MAXIMUM_SOCKET_PATH_BYTES = 100;
const MAXIMUM_STDERR_RECORD_BYTES = 4 * 1024;
const MAXIMUM_LAUNCH_ENVELOPE_BYTES = 4 * 1024;
const RECOVERY_DELAYS_MS = [0, 100, 500] as const;
const STDERR_RATE = 20;
const STDERR_BURST = 40;
const SOCKET_FILE = "plugin.sock";
const EMPTY_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({});

const CHILD_LEVELS = ["debug", "info", "warn", "error"] as const;
const RESERVED_PLUGIN_EVENTS = new Set(["rpc.completed"]);
const RESERVED_PLUGIN_FIELDS = new Set([
  "event",
  "level",
  "exitCode",
  "providerInstanceId",
  "providerTypeId",
  "recoveryAttempt",
  "signal",
]);
export type ChildLevel = (typeof CHILD_LEVELS)[number];
export type StderrFieldKind = "number" | "enum";

export type StderrFieldDeclaration = Readonly<{
  readonly kind: StderrFieldKind;
  readonly values?: readonly string[];
}>;

export type StderrEventDeclaration = Readonly<{
  readonly levels: readonly ChildLevel[];
  readonly fields?: Readonly<Record<string, StderrFieldDeclaration>>;
}>;

type PluginLaunchDescriptor = Readonly<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly providerTypeId: string;
  readonly providerInstanceId?: string;
  readonly stderrEvents?: Readonly<Record<string, StderrEventDeclaration>>;
}>;

type PluginSupervisorReason =
  | "EXECUTABLE_INVALID"
  | "EXECUTABLE_UNAVAILABLE"
  | "LAUNCH_INVALID"
  | "LAUNCH_FAILED"
  | "SOCKET_INVALID"
  | "SOCKET_UNAVAILABLE"
  | "HEALTH_FAILED"
  | "AUTHENTICATION_FAILED"
  | "PROVIDER_TYPE_MISMATCH"
  | "CONTRACT_MAJOR_UNSUPPORTED"
  | "RPC_UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "CALL_CANCELLED"
  | "RECOVERY_EXHAUSTED"
  | "SHUTDOWN_FAILED";

type PluginSupervisorError = Readonly<{
  readonly _tag: "PluginSupervisorError";
  readonly reason: PluginSupervisorReason;
}>;

const pluginError = (reason: PluginSupervisorReason): PluginSupervisorError =>
  Object.freeze({ _tag: "PluginSupervisorError" as const, reason });

const isPluginSupervisorError = (value: unknown): value is PluginSupervisorError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "PluginSupervisorError" &&
  "reason" in value;

const encodeLaunchEnvelope = ({
  bearer,
  socketPath,
}: {
  readonly bearer: string;
  readonly socketPath: string;
}): string => {
  const encoded = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    socket_path: socketPath,
    bearer,
  });
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_LAUNCH_ENVELOPE_BYTES) {
    throw pluginError("LAUNCH_INVALID");
  }
  return encoded;
};

// fallow-ignore-next-line complexity -- Executable trust validation handles ownership, symlink, mode, and OS lookup failures together.
const validateExecutableAsync = async (executable: string): Promise<void> => {
  if (!isAbsolute(executable)) {
    throw pluginError("EXECUTABLE_INVALID");
  }

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(executable);
  } catch {
    throw pluginError("EXECUTABLE_UNAVAILABLE");
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const ownedByRuntimeUser = stats.uid === 0 || stats.uid === currentUid;
  const privateMode = (stats.mode & 0o022) === 0;
  const executableMode = (stats.mode & 0o111) !== 0;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !ownedByRuntimeUser ||
    !privateMode ||
    !executableMode
  ) {
    throw pluginError("EXECUTABLE_INVALID");
  }
};

const validatePluginExecutable = (executable: string): Effect.Effect<void, PluginSupervisorError> =>
  Effect.tryPromise({
    try: () => validateExecutableAsync(executable),
    catch: (error) => (isPluginSupervisorError(error) ? error : pluginError("EXECUTABLE_INVALID")),
  });

const validSafeText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value);

// fallow-ignore-next-line complexity -- Validation is the single trust-boundary gate for code-owned launch descriptors.
const validateDescriptor = (
  descriptor: PluginLaunchDescriptor,
): PluginSupervisorError | undefined => {
  if (
    !validSafeText(descriptor.executable, 4096) ||
    !isAbsolute(descriptor.executable) ||
    !Array.isArray(descriptor.args) ||
    descriptor.args.some((argument) => !validSafeText(argument, 2048))
  ) {
    return pluginError("LAUNCH_INVALID");
  }
  if (!validSafeText(descriptor.providerTypeId, 256)) {
    return pluginError("LAUNCH_INVALID");
  }
  if (
    descriptor.providerInstanceId !== undefined &&
    !validSafeText(descriptor.providerInstanceId, 256)
  ) {
    return pluginError("LAUNCH_INVALID");
  }
  for (const [event, declaration] of Object.entries(descriptor.stderrEvents ?? {})) {
    if (
      !validSafeText(event, 128) ||
      RESERVED_PLUGIN_EVENTS.has(event) ||
      event.startsWith("server.") ||
      declaration === null ||
      typeof declaration !== "object" ||
      !Array.isArray(declaration.levels) ||
      declaration.levels.length === 0
    ) {
      return pluginError("LAUNCH_INVALID");
    }
    if (declaration.levels.some((level) => !CHILD_LEVELS.includes(level))) {
      return pluginError("LAUNCH_INVALID");
    }
    for (const [field, fieldDeclaration] of Object.entries(declaration.fields ?? {})) {
      if (
        !validSafeText(field, 64) ||
        RESERVED_PLUGIN_FIELDS.has(field) ||
        fieldDeclaration === null ||
        typeof fieldDeclaration !== "object" ||
        (fieldDeclaration.kind !== "number" && fieldDeclaration.kind !== "enum") ||
        (fieldDeclaration.kind === "enum" &&
          (!Array.isArray(fieldDeclaration.values) ||
            fieldDeclaration.values.length === 0 ||
            fieldDeclaration.values.some((value) => !validSafeText(value, 256))))
      ) {
        return pluginError("LAUNCH_INVALID");
      }
    }
  }
  return undefined;
};

const authInterceptor =
  (bearer: string) =>
  (
    next: Parameters<
      NonNullable<Parameters<typeof createConnectTransport>[0]["interceptors"]>[number]
    >[0],
  ) =>
  async (request: Parameters<typeof next>[0]) => {
    request.header.set("authorization", `Bearer ${bearer}`);
    return next(request);
  };

type RawClients = Readonly<{
  readonly health: Client<typeof HealthService>;
  readonly plugin: Client<typeof PluginService>;
  readonly library: Client<typeof LibraryService>;
  readonly playback: Client<typeof PlaybackService>;
  readonly watchState: Client<typeof WatchStateService>;
}>;

type SupervisedCallOptions = Omit<CallOptions, "timeoutMs" | "headers"> &
  Readonly<{
    readonly timeoutMs: number;
    readonly headers?: HeadersInit;
  }>;

type SupervisedClient<T extends DescService> = {
  readonly [Key in keyof Client<T>]: Client<T>[Key] extends (
    request: infer Request,
    options?: infer _Options,
  ) => Promise<infer Response>
    ? (
        request: Request,
        options: SupervisedCallOptions,
      ) => Effect.Effect<Response, PluginSupervisorError>
    : never;
};

type SupervisedPlugin = Readonly<{
  readonly providerTypeId: string;
  readonly providerInstanceId?: string;
  readonly clients: Readonly<{
    readonly health: SupervisedClient<typeof HealthService>;
    readonly plugin: SupervisedClient<typeof PluginService>;
    readonly library: SupervisedClient<typeof LibraryService>;
    readonly playback: SupervisedClient<typeof PlaybackService>;
    readonly watchState: SupervisedClient<typeof WatchStateService>;
  }>;
}>;

type EmitLog = (
  level: ChildLevel,
  event: string,
  fields?: Readonly<Record<string, number | string | boolean>>,
) => Effect.Effect<void>;

const pluginIdentityFields = (
  descriptor: PluginLaunchDescriptor,
): Readonly<Record<string, string>> => ({
  providerTypeId: descriptor.providerTypeId,
  ...(descriptor.providerInstanceId === undefined
    ? {}
    : { providerInstanceId: descriptor.providerInstanceId }),
});

type ExitInfo = Readonly<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;
type SupervisorClock = Readonly<{
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}>;

const makeSupervisorClock = (clock: Clock.Clock): SupervisorClock => ({
  now: () => Effect.runSync(clock.currentTimeMillis),
  sleep: (milliseconds) => Effect.runPromise(clock.sleep(Duration.millis(milliseconds))),
});

type RunningProcess = {
  readonly clock: SupervisorClock;
  readonly child: ChildProcessWithoutNullStreams;
  readonly directory: string;
  readonly socketPath: string;
  readonly clients: RawClients;
  readonly exit: Promise<ExitInfo>;
  termination: Promise<void> | undefined;
  alive: boolean;
  ready: boolean;
  terminating: boolean;
  spawnError: NodeJS.ErrnoException | undefined;
};

type SupervisorState = {
  readonly clock: SupervisorClock;
  readonly descriptor: PluginLaunchDescriptor;
  readonly root: string;
  readonly emit: EmitLog;
  readonly detachedRun: (effect: Effect.Effect<void>) => void;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
  readonly retired: Set<RunningProcess>;
  current: RunningProcess | undefined;
  pending: RunningProcess | undefined;
  launchGate: Deferred.Deferred<RunningProcess, PluginSupervisorError> | undefined;
  closed: boolean;
  terminal: boolean;
  refs: number;
  episodeLaunches: number;
  lastHealthyAt: number;
};

const killProcessGroup = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
  if (child.pid === undefined || child.pid === null) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !/(?:ESRCH|not found)/iu.test(error.message)) {
      throw error;
    }
  }
};

const removeLaunchDirectory = async (directory: string): Promise<void> => {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw pluginError("SHUTDOWN_FAILED");
  }
};

const processGroupExists = (child: ChildProcessWithoutNullStreams): boolean => {
  if (child.pid === undefined || child.pid === null) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && /(?:ESRCH|not found)/iu.test(error.message)) {
      return false;
    }
    throw error;
  }
};

const terminateProcessOnce = async (running: RunningProcess, graceMs: number): Promise<void> => {
  running.terminating = true;
  const terminationStartedAt = running.clock.now();
  killProcessGroup(running.child, "SIGTERM");
  const exited = await Promise.race([
    running.exit.then(() => true),
    running.clock.sleep(graceMs).then(() => false),
  ]);
  if (!exited) {
    killProcessGroup(running.child, "SIGKILL");
    await running.exit;
  } else if (processGroupExists(running.child)) {
    await running.clock.sleep(Math.max(0, graceMs - (running.clock.now() - terminationStartedAt)));
    if (processGroupExists(running.child)) {
      killProcessGroup(running.child, "SIGKILL");
    }
  }
  await removeLaunchDirectory(running.directory);
};

const terminateProcess = (running: RunningProcess, graceMs: number): Promise<void> => {
  if (running.termination !== undefined) {
    return running.termination;
  }
  const termination = terminateProcessOnce(running, graceMs);
  running.termination = termination;
  return termination;
};
const retireAndTerminate = async (
  state: SupervisorState,
  running: RunningProcess,
  graceMs: number,
): Promise<void> => {
  state.retired.add(running);
  await terminateProcess(running, graceMs);
  state.retired.delete(running);
};

const classifySpawnError = (error: NodeJS.ErrnoException | undefined): PluginSupervisorError => {
  if (error?.code === "ENOENT") {
    return pluginError("EXECUTABLE_UNAVAILABLE");
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return pluginError("EXECUTABLE_INVALID");
  }
  return pluginError("LAUNCH_FAILED");
};

const waitForSocket = async (
  running: RunningProcess,
  deadline: number,
  isClosed: () => boolean,
): Promise<void> => {
  let sawSocket = false;
  while (running.clock.now() < deadline) {
    if (isClosed()) {
      throw pluginError("SHUTDOWN_FAILED");
    }
    if (!running.alive) {
      throw classifySpawnError(running.spawnError);
    }
    try {
      const stats = await lstat(running.socketPath);
      if (!stats.isSocket()) {
        throw pluginError("SOCKET_INVALID");
      }
      sawSocket = true;
      if ((stats.mode & 0o777) === 0o600) {
        return;
      }
    } catch (error) {
      if (isPluginSupervisorError(error)) {
        throw error;
      }
    }
    await running.clock.sleep(20);
  }
  throw pluginError(sawSocket ? "SOCKET_INVALID" : "SOCKET_UNAVAILABLE");
};
const classifyConnectFailure = (error: unknown): PluginSupervisorError => {
  if (error instanceof ConnectError) {
    if (error.code === Code.Unauthenticated) {
      return pluginError("AUTHENTICATION_FAILED");
    }
    if (error.code === Code.Canceled) {
      return pluginError("CALL_CANCELLED");
    }
    if (error.code === Code.DeadlineExceeded) {
      return pluginError("DEADLINE_EXCEEDED");
    }
  }
  return pluginError("RPC_UNAVAILABLE");
};

const withDeadline = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  deadline: number,
  clock: SupervisorClock,
): Promise<Value> => {
  const remaining = deadline - clock.now();
  if (remaining <= 0) {
    throw pluginError("DEADLINE_EXCEEDED");
  }
  const controller = new AbortController();
  return Promise.race([
    operation(controller.signal),
    clock.sleep(remaining).then(() => {
      controller.abort();
      throw pluginError("DEADLINE_EXCEEDED");
    }),
  ]).finally(() => {
    controller.abort();
  });
};

const makeClients = (socketPath: string, bearer: string): RawClients => {
  const transport = createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "1.1",
    interceptors: [authInterceptor(bearer)],
    nodeOptions: { socketPath },
  });
  return {
    health: createClient(HealthService, transport),
    plugin: createClient(PluginService, transport),
    library: createClient(LibraryService, transport),
    playback: createClient(PlaybackService, transport),
    watchState: createClient(WatchStateService, transport),
  };
};

const runHandshake = async (
  clients: RawClients,
  descriptor: PluginLaunchDescriptor,
  deadline: number,
  clock: SupervisorClock,
): Promise<void> => {
  const remaining = () => Math.max(1, deadline - clock.now());
  let health;
  try {
    health = await withDeadline(
      (signal) => clients.health.check({}, { signal, timeoutMs: remaining() }),
      deadline,
      clock,
    );
  } catch (error) {
    throw isPluginSupervisorError(error) ? error : classifyConnectFailure(error);
  }
  if (health.status !== ServingStatus.SERVING) {
    throw pluginError("HEALTH_FAILED");
  }

  let identity;
  try {
    identity = await withDeadline(
      (signal) => clients.plugin.getInfo({}, { signal, timeoutMs: remaining() }),
      deadline,
      clock,
    );
  } catch (error) {
    throw isPluginSupervisorError(error) ? error : classifyConnectFailure(error);
  }
  const info = identity.pluginInfo;
  if (info === undefined || info.providerTypeId !== descriptor.providerTypeId) {
    throw pluginError("PROVIDER_TYPE_MISMATCH");
  }
  if (info.contractMajor !== CONTRACT_MAJOR) {
    throw pluginError("CONTRACT_MAJOR_UNSUPPORTED");
  }
};

// fallow-ignore-next-line complexity -- Stderr admission combines framing, schema allowlisting, and rate limiting at one boundary.
const consumeStderr = (
  running: RunningProcess,
  descriptor: PluginLaunchDescriptor,
  emit: EmitLog,
  detachedRun: (effect: Effect.Effect<void>) => void,
): void => {
  let buffered = "";
  let tokens = STDERR_BURST;
  let lastRefill = running.clock.now();
  let dropReported = false;
  const reject = () => {
    if (!dropReported) {
      dropReported = true;
      detachedRun(emit("warn", "plugin.stderr_rejected", pluginIdentityFields(descriptor)));
    }
  };
  const refill = () => {
    const now = running.clock.now();
    tokens = Math.min(STDERR_BURST, tokens + ((now - lastRefill) * STDERR_RATE) / 1_000);
    lastRefill = now;
  };
  // fallow-ignore-next-line complexity -- Record admission validates framing, JSON shape, declaration, types, and rate budget atomically.
  const consume = (record: string) => {
    if (Buffer.byteLength(record, "utf8") > MAXIMUM_STDERR_RECORD_BYTES) {
      reject();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(record);
    } catch {
      reject();
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      reject();
      return;
    }
    const event = Reflect.get(value, "event");
    const level = Reflect.get(value, "level");
    if (typeof event !== "string" || typeof level !== "string") {
      reject();
      return;
    }
    const declaration = descriptor.stderrEvents?.[event];
    if (declaration === undefined || !declaration.levels.includes(level as ChildLevel)) {
      reject();
      return;
    }
    refill();
    if (tokens < 1) {
      reject();
      return;
    }
    tokens -= 1;
    const declaredFields = declaration.fields ?? {};
    const fields: Record<string, number | string> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (key === "event" || key === "level") {
        continue;
      }
      const field = declaredFields[key];
      if (field === undefined) {
        reject();
        return;
      }
      if (field.kind === "number" && typeof fieldValue !== "number") {
        reject();
        return;
      }
      if (
        field.kind === "enum" &&
        (typeof fieldValue !== "string" || !field.values?.includes(fieldValue))
      ) {
        reject();
        return;
      }
      fields[key] = fieldValue as number | string;
    }
    detachedRun(
      emit(level as ChildLevel, event, { ...fields, ...pluginIdentityFields(descriptor) }),
    );
  };

  running.child.stderr.setEncoding("utf8");
  running.child.stderr.on("data", (chunk: string) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, "utf8") > MAXIMUM_STDERR_RECORD_BYTES * 2) {
      buffered = "";
      reject();
      return;
    }
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const record = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      consume(record);
    }
  });
};

const launchOnce = async (state: SupervisorState): Promise<RunningProcess> => {
  const directory = join(state.root, randomBytes(8).toString("hex"));
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const socketPath = join(directory, SOCKET_FILE);
  if (Buffer.byteLength(socketPath, "utf8") > MAXIMUM_SOCKET_PATH_BYTES) {
    await removeLaunchDirectory(directory);
    throw pluginError("LAUNCH_INVALID");
  }
  const bearer = randomBytes(32).toString("base64url");
  const envelope = encodeLaunchEnvelope({ bearer, socketPath });
  let child: ChildProcessWithoutNullStreams;
  try {
    // fallow-ignore-next-line security-sink -- Descriptor is server-owned, validated, and never derived from request or operator input.
    child = spawn(state.descriptor.executable, [...state.descriptor.args], {
      detached: true,
      env: EMPTY_ENVIRONMENT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    await removeLaunchDirectory(directory);
    throw pluginError("LAUNCH_FAILED");
  }
  child.stdout.resume();
  let resolveExit!: (exit: ExitInfo) => void;
  const exit = new Promise<ExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  const running: RunningProcess = {
    clock: state.clock,
    child,
    directory,
    socketPath,
    clients: makeClients(socketPath, bearer),
    exit,
    termination: undefined,
    alive: true,
    ready: false,
    terminating: false,
    spawnError: undefined,
  };
  state.pending = running;
  running.child.stdin.once("error", (error: NodeJS.ErrnoException) => {
    if (running.spawnError === undefined) {
      running.spawnError = error;
    }
  });
  let cleanupScheduled = false;
  const scheduleCleanup = () => {
    if (cleanupScheduled) {
      return;
    }
    cleanupScheduled = true;
    state.detachedRun(
      Effect.tryPromise({
        try: () => removeLaunchDirectory(running.directory),
        catch: () => pluginError("SHUTDOWN_FAILED"),
      }).pipe(
        Effect.catch(() =>
          state.emit("error", "plugin.cleanup_failed", pluginIdentityFields(state.descriptor)),
        ),
      ),
    );
  };
  const handleUnexpectedExit = (exitInfo: ExitInfo) => {
    if (!running.ready || running.terminating || state.current !== running) {
      return;
    }
    resetHealthyEpisodeIfElapsed(state);
    state.lastHealthyAt = 0;
    state.current = undefined;
    state.retired.add(running);
    state.detachedRun(
      state.emit("warn", "plugin.unexpected_exit", {
        ...pluginIdentityFields(state.descriptor),
        ...(exitInfo.code === null ? {} : { exitCode: exitInfo.code }),
        ...(exitInfo.signal === null ? {} : { signal: exitInfo.signal }),
      }),
    );
    state.detachedRun(
      Effect.tryPromise({
        try: () => retireAndTerminate(state, running, 100),
        catch: () => pluginError("SHUTDOWN_FAILED"),
      }).pipe(
        Effect.catch(() =>
          state.emit("error", "plugin.cleanup_failed", pluginIdentityFields(state.descriptor)),
        ),
      ),
    );
  };
  child.once("error", (error: NodeJS.ErrnoException) => {
    running.spawnError = error;
    running.alive = false;
    resolveExit({ code: null, signal: null });
    handleUnexpectedExit({ code: null, signal: null });
    scheduleCleanup();
  });
  child.once("exit", (code, signal) => {
    running.alive = false;
    resolveExit({ code, signal });
    handleUnexpectedExit({ code, signal });
    scheduleCleanup();
  });
  consumeStderr(running, state.descriptor, state.emit, state.detachedRun);
  try {
    running.child.stdin.end(envelope);
    const deadline = state.clock.now() + HANDSHAKE_TIMEOUT_MS;
    await waitForSocket(running, deadline, () => state.closed);
    await runHandshake(running.clients, state.descriptor, deadline, state.clock);
    if (state.closed) {
      await retireAndTerminate(state, running, SHUTDOWN_GRACE_MS);
      throw pluginError("SHUTDOWN_FAILED");
    }
    if (!running.alive) {
      throw classifySpawnError(running.spawnError);
    }
    running.ready = true;
    state.current = running;
    state.lastHealthyAt = state.clock.now();
    return running;
  } catch (error) {
    if (!running.terminating) {
      await retireAndTerminate(state, running, 100);
    }
    if (isPluginSupervisorError(error)) {
      throw error;
    }
    throw pluginError("LAUNCH_FAILED");
  } finally {
    if (state.pending === running) {
      state.pending = undefined;
    }
  }
};
// fallow-ignore-next-line complexity -- Recovery deliberately centralizes bounded retry and terminal classification.
const launchWithRecovery = (
  state: SupervisorState,
): Effect.Effect<RunningProcess, PluginSupervisorError> =>
  // fallow-ignore-next-line complexity -- Recovery deliberately centralizes bounded retry and terminal classification.
  Effect.gen(function* () {
    if (state.closed) {
      return yield* Effect.fail(pluginError("SHUTDOWN_FAILED"));
    }
    const availableAttempts = RECOVERY_DELAYS_MS.length - state.episodeLaunches;
    if (availableAttempts <= 0) {
      state.terminal = true;
      state.detachedRun(
        state.emit("error", "plugin.recovery_exhausted", {
          ...pluginIdentityFields(state.descriptor),
          recoveryAttempt: state.episodeLaunches,
        }),
      );
      return yield* Effect.fail(pluginError("RECOVERY_EXHAUSTED"));
    }
    let lastFailure: PluginSupervisorError = pluginError("LAUNCH_FAILED");
    for (let attempt = 0; attempt < availableAttempts; attempt += 1) {
      if (state.closed) {
        return yield* Effect.fail(pluginError("SHUTDOWN_FAILED"));
      }
      const launchNumber = state.episodeLaunches;
      if (launchNumber > 0) {
        const recoveryDelay = RECOVERY_DELAYS_MS[launchNumber] ?? 0;
        yield* Effect.sleep(`${recoveryDelay} millis`);
      }
      if (state.closed) {
        return yield* Effect.fail(pluginError("SHUTDOWN_FAILED"));
      }
      state.episodeLaunches += 1;
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => launchOnce(state),
          catch: (error) => (isPluginSupervisorError(error) ? error : pluginError("LAUNCH_FAILED")),
        }),
      );
      if (Exit.isSuccess(result)) {
        return result.value;
      }
      const failure = result.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
      lastFailure = isPluginSupervisorError(failure) ? failure : pluginError("LAUNCH_FAILED");
      if (
        lastFailure.reason === "EXECUTABLE_INVALID" ||
        lastFailure.reason === "EXECUTABLE_UNAVAILABLE" ||
        lastFailure.reason === "LAUNCH_INVALID" ||
        lastFailure.reason === "SOCKET_INVALID" ||
        lastFailure.reason === "AUTHENTICATION_FAILED" ||
        lastFailure.reason === "PROVIDER_TYPE_MISMATCH" ||
        lastFailure.reason === "CONTRACT_MAJOR_UNSUPPORTED"
      ) {
        return yield* Effect.fail(lastFailure);
      }
    }
    state.terminal = true;
    state.detachedRun(
      state.emit("error", "plugin.recovery_exhausted", {
        ...pluginIdentityFields(state.descriptor),
        recoveryAttempt: state.episodeLaunches,
      }),
    );
    return yield* Effect.fail(pluginError("RECOVERY_EXHAUSTED"));
  });

const makeSupervisedClient = <T extends DescService>(
  serviceName: keyof RawClients,
  state: SupervisorState,
): SupervisedClient<T> =>
  new Proxy(
    {},
    {
      get: (_target, method: string) => (request: unknown, options: SupervisedCallOptions) => {
        let rpcStarted = false;
        return Effect.gen(function* () {
          if (
            options === undefined ||
            !Number.isFinite(options.timeoutMs) ||
            options.timeoutMs <= 0
          ) {
            return yield* Effect.fail(pluginError("LAUNCH_INVALID"));
          }
          const deadline = state.clock.now() + options.timeoutMs;
          const running = yield* ensureReady(state, deadline);
          const remaining = deadline - state.clock.now();
          if (remaining <= 0) {
            return yield* Effect.fail(pluginError("DEADLINE_EXCEEDED"));
          }
          const rawClient = state.current?.clients[serviceName] ?? running.clients;
          const rawMethod = Reflect.get(rawClient, method) as (
            input: unknown,
            callOptions?: CallOptions,
          ) => Promise<unknown>;
          rpcStarted = true;
          const call = Effect.tryPromise({
            try: (signal) =>
              rawMethod(request, {
                ...options,
                signal,
                timeoutMs: Math.max(1, remaining),
              }),
            catch: classifyConnectFailure,
          });
          const result = yield* Effect.timeoutOrElse(call, {
            duration: `${remaining} millis`,
            orElse: () => Effect.fail(pluginError("DEADLINE_EXCEEDED")),
          });
          return result;
        }).pipe(
          Effect.catch((error: PluginSupervisorError) => {
            if (error.reason !== "DEADLINE_EXCEEDED" || !rpcStarted) {
              return Effect.fail(error);
            }
            state.detachedRun(
              state.emit(
                "warn",
                "plugin.deadline_exceeded",
                pluginIdentityFields(state.descriptor),
              ),
            );
            const running = state.current;
            if (running !== undefined) {
              resetHealthyEpisodeIfElapsed(state);
              state.lastHealthyAt = 0;
              state.current = undefined;
              return Effect.tryPromise({
                try: () => retireAndTerminate(state, running, DEADLINE_CANCELLATION_GRACE_MS),
                catch: (cleanupError) =>
                  isPluginSupervisorError(cleanupError)
                    ? cleanupError
                    : pluginError("SHUTDOWN_FAILED"),
              }).pipe(Effect.andThen(Effect.fail(pluginError("DEADLINE_EXCEEDED"))));
            }
            return Effect.fail(error);
          }),
        );
      },
    },
  ) as SupervisedClient<T>;

const awaitReady = (
  state: SupervisorState,
  gate: Deferred.Deferred<RunningProcess, PluginSupervisorError>,
  deadline: number | undefined,
): Effect.Effect<RunningProcess, PluginSupervisorError> => {
  if (deadline === undefined) {
    return Deferred.await(gate);
  }
  const remaining = deadline - state.clock.now();
  if (remaining <= 0) {
    return Effect.fail(pluginError("DEADLINE_EXCEEDED"));
  }
  return Effect.timeoutOrElse(Deferred.await(gate), {
    duration: `${remaining} millis`,
    orElse: () => Effect.fail(pluginError("DEADLINE_EXCEEDED")),
  });
};

const resetHealthyEpisodeIfElapsed = (state: SupervisorState): void => {
  if (state.lastHealthyAt > 0 && state.clock.now() - state.lastHealthyAt >= HEALTHY_RESET_MS) {
    state.episodeLaunches = 0;
    state.terminal = false;
  }
};

const ensureReady = (
  state: SupervisorState,
  deadline: number | undefined = undefined,
): Effect.Effect<RunningProcess, PluginSupervisorError> =>
  Effect.suspend(() => {
    if (state.closed) {
      return Effect.fail(pluginError("SHUTDOWN_FAILED"));
    }
    if (state.current?.alive === true && state.current.ready) {
      resetHealthyEpisodeIfElapsed(state);
      return Effect.succeed(state.current);
    }
    if (state.current !== undefined && !state.current.alive) {
      state.lastHealthyAt = 0;
    }
    if (state.terminal) {
      return Effect.fail(pluginError("RECOVERY_EXHAUSTED"));
    }
    if (state.launchGate !== undefined) {
      return awaitReady(state, state.launchGate, deadline);
    }
    const gate = Deferred.makeUnsafe<RunningProcess, PluginSupervisorError>();
    state.launchGate = gate;
    const launch = launchWithRecovery(state).pipe(
      Effect.matchCauseEffect({
        onSuccess: (running) =>
          Effect.sync(() => {
            state.launchGate = undefined;
            Deferred.doneUnsafe(gate, Effect.succeed(running));
          }),
        onFailure: (cause) =>
          Effect.sync(() => {
            state.launchGate = undefined;
            Deferred.doneUnsafe(gate, Effect.failCause(cause));
          }),
      }),
    );
    state.runFork(launch);
    return awaitReady(state, gate, deadline);
  });

const makeManagedHandle = (
  clock: SupervisorClock,
  descriptor: PluginLaunchDescriptor,
  root: string,
  emit: EmitLog,
  detachedRun: (effect: Effect.Effect<void>) => void,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => void,
): SupervisorState => ({
  clock,
  descriptor,
  root,
  emit,
  detachedRun,
  runFork,
  retired: new Set(),
  current: undefined,
  pending: undefined,
  launchGate: undefined,
  closed: false,
  terminal: false,
  refs: 0,
  episodeLaunches: 0,
  lastHealthyAt: 0,
});

const descriptorKey = (descriptor: PluginLaunchDescriptor): string =>
  JSON.stringify([
    descriptor.executable,
    descriptor.args,
    descriptor.providerTypeId,
    descriptor.providerInstanceId,
    descriptor.stderrEvents,
  ]);

const stopHandle = async (state: SupervisorState): Promise<void> => {
  state.closed = true;
  const processes = [
    ...new Set(
      [state.current, state.pending, ...state.retired].filter(
        (running): running is RunningProcess => running !== undefined,
      ),
    ),
  ];
  state.current = undefined;
  state.pending = undefined;
  const results = await Promise.allSettled(
    processes.map((running) => retireAndTerminate(state, running, SHUTDOWN_GRACE_MS)),
  );
  if (state.launchGate !== undefined) {
    await Effect.runPromiseExit(Deferred.await(state.launchGate));
  }
  if (results.some((result) => result.status === "rejected")) {
    throw pluginError("SHUTDOWN_FAILED");
  }
};

const makeRootDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "n-"));
  await chmod(root, 0o700);
  return root;
};

const contextService = Context.Service;

interface PluginSupervisorService {
  readonly acquire: (
    descriptor: PluginLaunchDescriptor,
  ) => Effect.Effect<SupervisedPlugin, PluginSupervisorError, Scope.Scope>;
}

class PluginSupervisor extends contextService<PluginSupervisor, PluginSupervisorService>()(
  "@nama/server/PluginSupervisor",
) {
  static readonly layer = () =>
    Layer.effect(
      PluginSupervisor,
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const clock = makeSupervisorClock(yield* Clock.Clock);
        const detachedRun = (effect: Effect.Effect<void>): void => {
          Effect.runForkWith(context)(effect);
        };
        const runFork = <A, E>(effect: Effect.Effect<A, E>): void => {
          Effect.runForkWith(context)(effect);
        };
        const emit: EmitLog = (level, event, fields = {}) => logPluginEvent(level, event, fields);
        const handles = new Map<string, SupervisorState>();
        const root = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: makeRootDirectory,
            catch: () => pluginError("LAUNCH_FAILED"),
          }),
          (directory) =>
            Effect.tryPromise({
              try: async () => {
                try {
                  await Promise.all([...handles.values()].map(stopHandle));
                } finally {
                  handles.clear();
                  await rm(directory, { recursive: true, force: true });
                }
              },
              catch: () => pluginError("SHUTDOWN_FAILED"),
            }).pipe(Effect.orDie),
        );
        const acquire = (descriptor: PluginLaunchDescriptor) =>
          Effect.gen(function* () {
            const descriptorError = validateDescriptor(descriptor);
            if (descriptorError !== undefined) {
              return yield* Effect.fail(descriptorError);
            }
            yield* validatePluginExecutable(descriptor.executable);
            const key = descriptorKey(descriptor);
            let state = handles.get(key);
            if (state === undefined) {
              state = makeManagedHandle(clock, descriptor, root, emit, detachedRun, runFork);
              handles.set(key, state);
            }
            const managedState = state;
            managedState.refs += 1;
            return yield* Effect.acquireRelease(
              Effect.onExitIf(ensureReady(managedState), Exit.isFailure, () =>
                Effect.sync(() => {
                  managedState.refs -= 1;
                  if (managedState.refs === 0) {
                    managedState.closed = true;
                    handles.delete(key);
                  }
                }),
              ).pipe(
                Effect.map((): SupervisedPlugin => ({
                  providerTypeId: descriptor.providerTypeId,
                  ...(descriptor.providerInstanceId === undefined
                    ? {}
                    : { providerInstanceId: descriptor.providerInstanceId }),
                  clients: {
                    health: makeSupervisedClient("health", managedState),
                    plugin: makeSupervisedClient("plugin", managedState),
                    library: makeSupervisedClient("library", managedState),
                    playback: makeSupervisedClient("playback", managedState),
                    watchState: makeSupervisedClient("watchState", managedState),
                  },
                })),
              ),
              () =>
                Effect.tryPromise({
                  try: async () => {
                    managedState.refs -= 1;
                    if (managedState.refs === 0) {
                      handles.delete(key);
                      await stopHandle(managedState);
                    }
                  },
                  catch: () => pluginError("SHUTDOWN_FAILED"),
                }).pipe(Effect.orDie),
            );
          });
        return PluginSupervisor.of({ acquire });
      }),
    );
}

export { PluginSupervisor };
export type { PluginLaunchDescriptor, PluginSupervisorError, PluginSupervisorReason };
