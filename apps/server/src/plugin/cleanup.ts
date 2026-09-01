import { scheduler } from "node:timers/promises";

import { Effect } from "effect";

import { PROCESS_TERMINATION_TIMEOUT_MILLISECONDS } from "./constants.ts";
import { PluginSupervisorCleanupError } from "./errors.ts";
import type { PluginSupervisorCleanupFailure } from "./errors.ts";
import type { RunningPlugin } from "./model.ts";
import { removePath } from "./runtime.ts";

const PROCESS_SIGNAL_PROBE = 0;
const isMissingProcessError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return code === "ESRCH";
};

const signalProcessGroup = (plugin: RunningPlugin, signal: NodeJS.Signals): void => {
  const processId = plugin.child.pid;
  if (processId === undefined) {
    return;
  }
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw new Error("process group signal failed", { cause: error });
    }
  }
};

const processGroupExited = (processId: number): boolean => {
  try {
    process.kill(-processId, PROCESS_SIGNAL_PROBE);
    return false;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return true;
    }
    if (typeof error === "object" && error !== null && "code" in error) {
      const { code } = error;
      if (code === "EPERM") {
        return false;
      }
    }
    throw new Error("process group status check failed", { cause: error });
  }
};

const waitForProcessGroupExit = async (processId: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted || processGroupExited(processId)) {
    return;
  }
  await scheduler.yield();
  return waitForProcessGroupExit(processId, signal);
};

const awaitProcessGroupExit = (
  plugin: RunningPlugin,
): Effect.Effect<void, PluginSupervisorCleanupFailure> => {
  const processId = plugin.child.pid;
  if (processId === undefined) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: () => new PluginSupervisorCleanupError(),
    try: (signal) => waitForProcessGroupExit(processId, signal),
  });
};

const terminatePluginProcess = (
  plugin: RunningPlugin,
): Effect.Effect<boolean, PluginSupervisorCleanupFailure> =>
  Effect.try({
    catch: () => new PluginSupervisorCleanupError(),
    try: () => {
      signalProcessGroup(plugin, "SIGTERM");
    },
  }).pipe(Effect.andThen(waitForTermination(plugin)));

const waitForTermination = (
  plugin: RunningPlugin,
): Effect.Effect<boolean, PluginSupervisorCleanupFailure> => {
  const exited = awaitProcessGroupExit(plugin).pipe(Effect.as(true));
  const timeout = Effect.sleep(PROCESS_TERMINATION_TIMEOUT_MILLISECONDS).pipe(Effect.as(false));
  return Effect.raceFirst(exited, timeout);
};

const awaitPluginStop = (
  plugin: RunningPlugin,
): Effect.Effect<unknown, PluginSupervisorCleanupFailure> => {
  const processExit = Effect.promise(() => plugin.exit);
  const groupExit = awaitProcessGroupExit(plugin);
  return Effect.all([processExit, groupExit] as const, { concurrency: "unbounded" });
};

const stopPlugin = (plugin: RunningPlugin): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.gen(function* stopPluginProcess() {
    plugin.stop.requested = true;
    const groupExited = yield* terminatePluginProcess(plugin);
    if (!groupExited) {
      yield* Effect.try({
        catch: () => new PluginSupervisorCleanupError(),
        try: () => {
          signalProcessGroup(plugin, "SIGKILL");
        },
      });
    }
    yield* awaitPluginStop(plugin);
    yield* removePath(plugin.launchDirectory);
  });

export { stopPlugin };
