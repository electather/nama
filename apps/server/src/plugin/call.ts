import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect } from "effect";

import { RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS } from "./constants.ts";
import { PluginDeadlineExceeded, PluginUnavailable } from "./errors.ts";
import type {
  PluginDeadlineFailure,
  PluginRpcFailure,
  PluginUnavailableFailure,
} from "./errors.ts";
import { beginPluginRecovery, ensureRunningPlugin, withPluginDemand } from "./lifecycle.ts";
import type { BeginRecoveryOptions, RecoveryOptions } from "./lifecycle.ts";
import { pluginLifecycleMessage } from "./logging.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type { PluginHandleState, RunningPlugin } from "./model.ts";
import { callPlugin } from "./protocol.ts";

const NON_POSITIVE_DEADLINE_MILLISECONDS = 0;

interface SupervisedCall<Input extends DescMessage, Output extends DescMessage> {
  readonly deadlineMilliseconds: number;
  readonly method: DescMethodUnary<Input, Output>;
  readonly options: RecoveryOptions;
  readonly request: MessageInitShape<Input>;
  readonly state: PluginHandleState;
}

interface CallRecovery {
  readonly failure: PluginCallFailure;
  readonly options: RecoveryOptions;
  readonly selectedPlugin: RunningPlugin | typeof ABSENT_PLUGIN;
  readonly state: PluginHandleState;
}

type PluginCallFailure = PluginDeadlineFailure | PluginRpcFailure | PluginUnavailableFailure;

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
  );
  const deadlineExceeded = Effect.fail(new PluginDeadlineExceeded());
  const deadline = Effect.sleep(deadlineMilliseconds).pipe(Effect.andThen(deadlineExceeded));
  return Effect.raceFirst(withPluginDemand(state, operation), deadline).pipe(
    Effect.tapError((failure) =>
      recoverFromCallFailure({ failure, options, selectedPlugin, state }),
    ),
  );
};

const recoverFromCallFailure = ({
  failure,
  options,
  selectedPlugin,
  state,
}: CallRecovery): Effect.Effect<void> => {
  if (selectedPlugin === ABSENT_PLUGIN) {
    return Effect.void;
  }
  if (failure instanceof PluginDeadlineExceeded) {
    options.emit(
      Effect.logWarning(pluginLifecycleMessage(options.descriptor, "plugin.rpc_deadline_exceeded")),
    );
    const recovery: BeginRecoveryOptions = {
      ...options,
      graceMilliseconds: RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS,
      plugin: selectedPlugin,
    };
    return beginPluginRecovery(state, recovery);
  }
  if (failure instanceof PluginUnavailable && failure.reason === "plugin_exited") {
    const recovery: BeginRecoveryOptions = {
      ...options,
      graceMilliseconds: 0,
      plugin: selectedPlugin,
    };
    return beginPluginRecovery(state, recovery);
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
