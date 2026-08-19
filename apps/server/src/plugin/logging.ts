import type { Readable } from "node:stream";

import { Effect } from "effect";

import type { EventMessage } from "../logging/record.ts";
import type {
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PreparedPluginLaunch,
  ProcessExit,
} from "./model.ts";
import { makePluginStderrParser } from "./stderr.ts";
import type { AcceptedPluginStderrRecord } from "./stderr.ts";

interface PluginLogContext {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launch: PreparedPluginLaunch;
}

const optionalPluginFields = (
  pluginFields: Readonly<Record<string, number | string>> | undefined,
): Readonly<Pick<EventMessage, "pluginFields">> => {
  if (pluginFields === undefined) {
    return {};
  }
  return { pluginFields };
};

const optionalProviderInstance = (
  launch: PreparedPluginLaunch,
): Readonly<Pick<EventMessage, "providerInstanceId">> => {
  if (launch.kind !== "instance") {
    return {};
  }
  return { providerInstanceId: launch.providerInstanceId };
};

const pluginLogMessage = (
  context: PluginLogContext,
  event: string,
  pluginFields?: Readonly<Record<string, number | string>>,
): EventMessage => ({
  event,
  ...optionalPluginFields(pluginFields),
  ...optionalProviderInstance(context.launch),
  providerType: context.descriptor.expectedProviderType,
});

const pluginLifecycleMessage = (
  context: PluginLogContext,
  event: string,
  fields: Readonly<Pick<EventMessage, "exitCode" | "recoveryAttempt" | "signal">> = {},
): EventMessage => ({ ...pluginLogMessage(context, event), ...fields });
const pluginProcessExitLog = (
  context: PluginLogContext,
  processExit: ProcessExit,
): Effect.Effect<void> => {
  const fields: { exitCode?: number; signal?: NodeJS.Signals } = {};
  if (processExit.code !== null) {
    fields.exitCode = processExit.code;
  }
  if (processExit.signal !== null) {
    fields.signal = processExit.signal;
  }
  return Effect.logWarning(pluginLifecycleMessage(context, "plugin.process_exited", fields));
};

const emitPluginStderrRecord = (
  emit: PluginLogEmitter,
  context: PluginLogContext,
  record: AcceptedPluginStderrRecord,
): void => {
  const message = pluginLogMessage(context, record.event, record.fields);
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

const attachPluginStderr = (
  stderr: Readable,
  context: PluginLogContext,
  emit: PluginLogEmitter,
): void => {
  const stderrParser = makePluginStderrParser(context.descriptor.stderrEvents, {
    accepted: (record) => {
      emitPluginStderrRecord(emit, context, record);
    },
    dropped: () => {
      emit(Effect.logWarning(pluginLogMessage(context, "plugin.stderr_dropped")));
    },
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrParser.write(chunk);
  });
};

export { attachPluginStderr, pluginLifecycleMessage, pluginProcessExitLog };
export type { PluginLogContext };
