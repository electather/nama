import type { Readable } from "node:stream";

import { Effect } from "effect";

import type { EventMessage } from "../logging/record.ts";
import type { PluginLaunchDescriptor, PluginLogEmitter } from "./model.ts";
import { makePluginStderrParser } from "./stderr.ts";
import type { AcceptedPluginStderrRecord } from "./stderr.ts";

const optionalPluginFields = (
  pluginFields: Readonly<Record<string, number | string>> | undefined,
): Readonly<Pick<EventMessage, "pluginFields">> => {
  if (pluginFields === undefined) {
    return {};
  }
  return { pluginFields };
};

const optionalProviderInstance = (
  providerInstanceId: string | undefined,
): Readonly<Pick<EventMessage, "providerInstanceId">> => {
  if (providerInstanceId === undefined) {
    return {};
  }
  return { providerInstanceId };
};

const pluginLogMessage = (
  descriptor: PluginLaunchDescriptor,
  event: string,
  pluginFields?: Readonly<Record<string, number | string>>,
): EventMessage => ({
  event,
  ...optionalPluginFields(pluginFields),
  ...optionalProviderInstance(descriptor.providerInstanceId),
  providerType: descriptor.expectedProviderType,
});

const pluginLifecycleMessage = (
  descriptor: PluginLaunchDescriptor,
  event: string,
  fields: Readonly<Pick<EventMessage, "exitCode" | "recoveryAttempt" | "signal">> = {},
): EventMessage => ({ ...pluginLogMessage(descriptor, event), ...fields });

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

const attachPluginStderr = (
  stderr: Readable,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
): void => {
  const stderrParser = makePluginStderrParser(descriptor.stderrEvents, {
    accepted: (record) => {
      emitPluginStderrRecord(emit, descriptor, record);
    },
    dropped: () => {
      emit(Effect.logWarning(pluginLogMessage(descriptor, "plugin.stderr_dropped")));
    },
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrParser.write(chunk);
  });
};

export { attachPluginStderr, pluginLifecycleMessage };
