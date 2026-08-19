import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect, Exit } from "effect";

import { RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS } from "./constants.ts";
import { PluginDeadlineExceeded, PluginUnavailable, unavailable } from "./errors.ts";
import type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginUnavailableFailure,
} from "./errors.ts";
import {
  beginPluginRecovery,
  ensureRunningPlugin,
  retirePluginHandle,
  beginPluginRetirement,
  withPluginDemand,
} from "./lifecycle.ts";
import type { RecoveryOptions } from "./lifecycle.ts";
import { pluginLifecycleMessage } from "./logging.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type { PluginHandleState, RunningPlugin } from "./model.ts";
import { callPlugin } from "./protocol.ts";

const NON_POSITIVE_DEADLINE_MILLISECONDS = 0;
const NO_RECOVERY_GRACE_MILLISECONDS = 0;

interface SupervisedCall<Input extends DescMessage, Output extends DescMessage> {
  readonly deadlineMilliseconds: number;
  readonly method: DescMethodUnary<Input, Output>;
  readonly options: RecoveryOptions;
  readonly request: MessageInitShape<Input>;
  readonly state: PluginHandleState;
}

interface CallRecoveryTarget {
  readonly options: RecoveryOptions;
  readonly plugin: RunningPlugin;
  readonly state: PluginHandleState;
}

interface CallRecovery {
  readonly failure: PluginCallFailure;
  readonly options: RecoveryOptions;
  readonly selectedPlugin: RunningPlugin | typeof ABSENT_PLUGIN;
  readonly state: PluginHandleState;
}

type PluginCallFailure = PluginDeadlineFailure | PluginRpcFailure | PluginUnavailableFailure;
const restorePluginCallExit = <Success, Failure>(
  exit: Exit.Exit<Success, Failure>,
): Effect.Effect<Success, Failure> => {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed(exit.value);
  }
  return Effect.failCause(exit.cause);
};

const withCandidateRetirement = <Success, Failure>(
  state: PluginHandleState,
  operation: Effect.Effect<Success, Failure>,
): Effect.Effect<Success, Failure | PluginUnavailableFailure> =>
  Effect.exit(operation).pipe(
    Effect.flatMap((exit) =>
      retirePluginHandle(state).pipe(
        Effect.mapError(() => unavailable("plugin_exited")),
        Effect.andThen(restorePluginCallExit(exit)),
      ),
    ),
    Effect.onInterrupt(() => beginPluginRetirement(state)),
  );

const callWithDeadline = <Input extends DescMessage, Output extends DescMessage>({
  deadlineMilliseconds,
  method,
  options,
  request,
  state,
}: SupervisedCall<Input, Output>): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
  let selectedPlugin: RunningPlugin | typeof ABSENT_PLUGIN = ABSENT_PLUGIN;
  const operation = ensureRunningPlugin(state, options).pipe(
    Effect.tap((plugin) =>
      Effect.sync(() => {
        selectedPlugin = plugin;
      }),
    ),
    Effect.flatMap((plugin) => callPlugin({ deadlineMilliseconds, method, plugin, request })),
    Effect.tapError((failure) =>
      recoverFromCallFailure({ failure, options, selectedPlugin, state }),
    ),
  );
  const deadlineExceeded = Effect.fail(new PluginDeadlineExceeded());
  const deadline = Effect.sleep(deadlineMilliseconds).pipe(Effect.andThen(deadlineExceeded));
  const demand = withPluginDemand(state, options, operation);
  let supervisedOperation = demand;
  if (options.launch.kind === "candidate") {
    supervisedOperation = withCandidateRetirement(state, demand);
  }
  return Effect.raceFirst(supervisedOperation, deadline).pipe(
    Effect.tapError((failure) =>
      recoverFromCallFailure({ failure, options, selectedPlugin, state }),
    ),
  );
};
const beginRecoveryAfterCall = (
  target: CallRecoveryTarget,
  graceMilliseconds: number,
): Effect.Effect<void> =>
  beginPluginRecovery(target.state, {
    ...target.options,
    graceMilliseconds,
    plugin: target.plugin,
  });

const recoverFromCallFailure = ({
  failure,
  options,
  selectedPlugin,
  state,
}: CallRecovery): Effect.Effect<void> => {
  if (selectedPlugin === ABSENT_PLUGIN || options.launch.kind === "candidate") {
    return Effect.void;
  }
  if (failure instanceof PluginDeadlineExceeded) {
    options.emit(
      Effect.logWarning(
        pluginLifecycleMessage(
          { descriptor: options.descriptor, launch: options.launch },
          "plugin.rpc_deadline_exceeded",
        ),
      ),
    );
    return beginRecoveryAfterCall(
      { options, plugin: selectedPlugin, state },
      RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS,
    );
  }
  if (failure instanceof PluginUnavailable && failure.reason === "plugin_exited") {
    return beginRecoveryAfterCall(
      { options, plugin: selectedPlugin, state },
      NO_RECOVERY_GRACE_MILLISECONDS,
    );
  }
  return Effect.void;
};

const callSupervisedPlugin = <Input extends DescMessage, Output extends DescMessage>(
  call: SupervisedCall<Input, Output>,
): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
  if (
    !Number.isFinite(call.deadlineMilliseconds) ||
    call.deadlineMilliseconds <= NON_POSITIVE_DEADLINE_MILLISECONDS
  ) {
    return Effect.fail(new PluginDeadlineExceeded());
  }
  return callWithDeadline(call);
};
export { callSupervisedPlugin };
export type { PluginCallFailure, SupervisedCall };
