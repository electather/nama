import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect } from "effect";

import { PluginDeadlineExceeded, PluginUnavailable } from "./errors.ts";
import type { PluginLifecycleHandle } from "./lifecycle.ts";
import type { PluginCallFailure, RunningPlugin } from "./model.ts";
import { callPlugin } from "./protocol.ts";

const NON_POSITIVE_DEADLINE_MILLISECONDS = 0;

interface SupervisedCall<Input extends DescMessage, Output extends DescMessage> {
  readonly deadlineMilliseconds: number;
  readonly lifecycle: PluginLifecycleHandle;
  readonly method: DescMethodUnary<Input, Output>;
  readonly request: MessageInitShape<Input>;
}

interface CallRecovery {
  readonly failure: PluginCallFailure;
  readonly lifecycle: PluginLifecycleHandle;
  readonly selectedPlugin: RunningPlugin | undefined;
}

const callWithDeadline = <Input extends DescMessage, Output extends DescMessage>({
  deadlineMilliseconds,
  lifecycle,
  method,
  request,
}: SupervisedCall<Input, Output>): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
  let selectedPlugin: RunningPlugin | undefined = undefined;
  const operation = lifecycle.withRunningPlugin((plugin) => {
    selectedPlugin = plugin;
    return callPlugin({ deadlineMilliseconds, method, plugin, request }).pipe(
      Effect.tapError((failure) => recoverFromCallFailure({ failure, lifecycle, selectedPlugin })),
    );
  });
  const deadlineExceeded = Effect.fail(new PluginDeadlineExceeded());
  const deadline = Effect.sleep(deadlineMilliseconds).pipe(Effect.andThen(deadlineExceeded));
  return Effect.raceFirst(operation, deadline).pipe(
    Effect.tapError((failure) => recoverFromCallFailure({ failure, lifecycle, selectedPlugin })),
  );
};

const recoverFromCallFailure = ({
  failure,
  lifecycle,
  selectedPlugin,
}: CallRecovery): Effect.Effect<void> => {
  if (selectedPlugin === undefined) {
    return Effect.void;
  }
  if (failure instanceof PluginDeadlineExceeded) {
    return lifecycle.recover(selectedPlugin, "rpc_deadline_exceeded");
  }
  if (failure instanceof PluginUnavailable && failure.reason === "plugin_exited") {
    return lifecycle.recover(selectedPlugin, "plugin_exited");
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
export type { SupervisedCall };
