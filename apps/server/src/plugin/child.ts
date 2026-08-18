import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { finished } from "node:stream/promises";

import { Effect } from "effect";

import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import type { ProcessExit, RunningPlugin } from "./model.ts";

interface PluginChildLifecycle {
  readonly exit: Promise<ProcessExit>;
  readonly launched: Promise<void>;
}

const spawnFailure = (error: unknown): PluginUnavailableFailure => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return unavailable("executable_invalid");
  }
  const { code } = error;
  if (code === "EAGAIN" || code === "ENOMEM") {
    return unavailable("plugin_exited");
  }
  return unavailable("executable_invalid");
};

const observePluginChild = (child: ChildProcessWithoutNullStreams): PluginChildLifecycle => {
  const launched = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<ProcessExit>();
  let didSpawn = false;
  child.on("error", (error) => {
    if (!didSpawn) {
      launched.reject(error);
      exited.resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
  child.once("spawn", () => {
    didSpawn = true;
    launched.resolve();
  });
  child.once("exit", (code, signal) => {
    exited.resolve({ code, signal });
  });
  return { exit: exited.promise, launched: launched.promise };
};

const writeLaunchEnvelope = (
  plugin: RunningPlugin,
  envelope: string,
): Effect.Effect<void, PluginUnavailableFailure> => {
  const completion = finished(plugin.child.stdin);
  plugin.child.stdin.end(envelope, "utf8");
  return Effect.tryPromise({
    catch: () => unavailable("plugin_exited"),
    try: () => completion,
  });
};

export { observePluginChild, spawnFailure, writeLaunchEnvelope };
export type { PluginChildLifecycle };
