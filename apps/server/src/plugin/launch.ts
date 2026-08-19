import { Effect, Exit } from "effect";

import { cleanupOwnedResources, ownCleanup, stopPlugin } from "./cleanup.ts";
import {
  HANDSHAKE_TIMEOUT_MILLISECONDS,
  LAUNCH_PROTOCOL_REJECTION_EXIT_CODE,
  RECOVERY_DELAYS_MILLISECONDS,
} from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import { pluginLifecycleMessage } from "./logging.ts";
import type {
  AcquiredPluginProcess,
  PreparedPluginLaunch,
  PluginLaunchDescriptor,
  PluginCleanupOwnership,
  PluginLogEmitter,
  PluginSpawnProcess,
  ProcessExit,
  RunningPlugin,
} from "./model.ts";
import { acquirePluginProcess, finishPluginStartup } from "./process.ts";
import type { AcquirePluginProcessOptions } from "./process.ts";
import { performHandshake } from "./protocol.ts";
import { makeLaunchDirectory, removePath } from "./runtime.ts";
import { validateExecutable } from "./validation.ts";

const FIRST_RECOVERY_ATTEMPT = 1;
const NO_RECOVERY_DELAY_MILLISECONDS = 0;

interface RecoveryResult {
  readonly launchesInEpisode: number;
  readonly plugin: RunningPlugin;
}

interface RecoveryPluginOptions {
  readonly descriptor: PluginLaunchDescriptor;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly launch: PreparedPluginLaunch;
  readonly ownership: PluginCleanupOwnership;
  readonly priorLaunches: number;
  readonly runtimeRoot: string;
  readonly spawnProcess: PluginSpawnProcess;
}

const launchFailureFromExit = (processExit: ProcessExit): PluginUnavailableFailure => {
  if (processExit.code === LAUNCH_PROTOCOL_REJECTION_EXIT_CODE) {
    return unavailable("launch_protocol_rejected");
  }
  return unavailable("plugin_exited");
};

const awaitLaunchFailure = (
  plugin: RunningPlugin,
): Effect.Effect<never, PluginUnavailableFailure> => {
  const processExit = Effect.promise(() => plugin.exit).pipe(
    Effect.flatMap((exit) => Effect.fail(launchFailureFromExit(exit))),
  );
  const failure = Effect.fail(unavailable("handshake_failed"));
  const handshakeTimeout = Effect.sleep(HANDSHAKE_TIMEOUT_MILLISECONDS).pipe(
    Effect.andThen(failure),
  );
  return Effect.raceFirst(processExit, handshakeTimeout);
};

const establishPluginConnection = (
  plugin: RunningPlugin,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<void, PluginUnavailableFailure> =>
  Effect.raceFirst(performHandshake(plugin, descriptor), awaitLaunchFailure(plugin)).pipe(
    Effect.asVoid,
  );

const launchAttempt = (
  acquired: AcquiredPluginProcess,
  options: RecoveryPluginOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  Effect.gen(function* launchPluginAttempt() {
    yield* finishPluginStartup(acquired, {
      descriptor: options.descriptor,
      emit: options.emit,
      launch: options.launch,
    });
    yield* establishPluginConnection(acquired.plugin, options.descriptor);
    return acquired.plugin;
  });

const acquirePlugin = (
  options: RecoveryPluginOptions,
  launchDirectory: string,
): Effect.Effect<AcquiredPluginProcess, PluginUnavailableFailure> => {
  const processOptions: AcquirePluginProcessOptions = { ...options, launchDirectory };
  return acquirePluginProcess(processOptions).pipe(
    Effect.tap((acquired) =>
      Effect.sync(() => {
        ownCleanup(options.ownership, stopPlugin(acquired.plugin));
      }),
    ),
    Effect.onError(() => cleanupOwnedResources(options.ownership).pipe(Effect.orDie)),
  );
};

const cleanupFailedLaunch = (
  exit: Exit.Exit<RunningPlugin, PluginUnavailableFailure>,
  ownership: PluginCleanupOwnership,
) => {
  if (Exit.isSuccess(exit)) {
    return Effect.void;
  }
  return cleanupOwnedResources(ownership).pipe(Effect.orDie);
};

const launchPlugin = (
  options: RecoveryPluginOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  validateExecutable(options.descriptor.executable, options.effectiveUserId).pipe(
    Effect.andThen(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* launchPluginProcess() {
          const launchDirectory = yield* makeLaunchDirectory(options.runtimeRoot);
          ownCleanup(options.ownership, removePath(launchDirectory));
          const acquired = yield* acquirePlugin(options, launchDirectory);
          const attempt = launchAttempt(acquired, options);
          return yield* restore(attempt).pipe(
            Effect.onExit((exit) => cleanupFailedLaunch(exit, options.ownership)),
          );
        }),
      ),
    ),
  );

const waitForRecoveryDelay = (delay: number | undefined): Effect.Effect<void> => {
  if (delay === undefined || delay === NO_RECOVERY_DELAY_MILLISECONDS) {
    return Effect.void;
  }
  return Effect.sleep(delay);
};

const retryableLaunchFailure = (failure: PluginUnavailableFailure): boolean =>
  failure.reason === "handshake_failed" || failure.reason === "plugin_exited";

const exhaustedRecovery = (
  options: RecoveryPluginOptions,
  failure: PluginUnavailableFailure,
  launchesInEpisode: number,
): Effect.Effect<never, PluginUnavailableFailure> => {
  options.emit(
    Effect.logError(
      pluginLifecycleMessage(
        { descriptor: options.descriptor, launch: options.launch },
        "plugin.recovery_exhausted",
        { recoveryAttempt: launchesInEpisode },
      ),
    ),
  );
  return Effect.fail(failure);
};

const recoverPluginAttempt = (
  options: RecoveryPluginOptions,
  launchesInEpisode: number,
  lastFailure: PluginUnavailableFailure,
): Effect.Effect<RecoveryResult, PluginUnavailableFailure> => {
  if (launchesInEpisode >= RECOVERY_DELAYS_MILLISECONDS.length) {
    return exhaustedRecovery(options, lastFailure, launchesInEpisode);
  }
  const recoveryAttempt = launchesInEpisode + FIRST_RECOVERY_ATTEMPT;
  options.emit(
    Effect.logInfo(
      pluginLifecycleMessage(
        { descriptor: options.descriptor, launch: options.launch },
        "plugin.recovery_attempt",
        { recoveryAttempt },
      ),
    ),
  );
  const delay = RECOVERY_DELAYS_MILLISECONDS[launchesInEpisode];
  const attempt = waitForRecoveryDelay(delay).pipe(Effect.andThen(launchPlugin(options)));
  return attempt.pipe(
    Effect.matchEffect({
      onFailure: (failure) => {
        if (!retryableLaunchFailure(failure)) {
          return Effect.fail(failure);
        }
        return recoverPluginAttempt(options, recoveryAttempt, failure);
      },
      onSuccess: (plugin) => Effect.succeed({ launchesInEpisode: recoveryAttempt, plugin }),
    }),
  );
};

const recoverPlugin = (
  options: RecoveryPluginOptions,
): Effect.Effect<RecoveryResult, PluginUnavailableFailure> =>
  recoverPluginAttempt(options, options.priorLaunches, unavailable("plugin_exited"));

export { recoverPlugin };
export type { RecoveryPluginOptions, RecoveryResult };
