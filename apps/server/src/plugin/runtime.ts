import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { DIRECTORY_MODE, MAXIMUM_SOCKET_PATH_BYTES, SOCKET_FILENAME } from "./constants.ts";
import {
  PluginSupervisorBoundaryError,
  PluginSupervisorCleanupError,
  unavailable,
} from "./errors.ts";
import type {
  PluginSupervisorBoundaryFailure,
  PluginSupervisorCleanupFailure,
  PluginUnavailableFailure,
} from "./errors.ts";

const removePath = (path: string): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.tryPromise({
    catch: () => new PluginSupervisorCleanupError(),
    try: () => rm(path, { force: true, recursive: true }),
  });

const socketPathFits = (root: string): boolean => {
  const maximumSocketPath = join(root, "p-XXXXXX", SOCKET_FILENAME);
  return Buffer.byteLength(maximumSocketPath, "utf8") <= MAXIMUM_SOCKET_PATH_BYTES;
};
const pluginSocketPath = (launchDirectory: string): string =>
  join(launchDirectory, SOCKET_FILENAME);

const hardenRuntimeRoot = async (root: string): Promise<string> => {
  try {
    await chmod(root, DIRECTORY_MODE);
    if (!socketPathFits(root)) {
      throw new PluginSupervisorBoundaryError();
    }
    return root;
  } catch {
    await rm(root, { force: true, recursive: true });
    throw new PluginSupervisorBoundaryError();
  }
};

const makeRuntimeRoot = (
  temporaryDirectory: string,
): Effect.Effect<string, PluginSupervisorBoundaryFailure> =>
  Effect.tryPromise({
    catch: () => new PluginSupervisorBoundaryError(),
    try: async () => hardenRuntimeRoot(await mkdtemp(join(temporaryDirectory, "nama-plugin-"))),
  });

const hardenLaunchDirectory = async (launchDirectory: string): Promise<string> => {
  try {
    await chmod(launchDirectory, DIRECTORY_MODE);
    return launchDirectory;
  } catch {
    await rm(launchDirectory, { force: true, recursive: true });
    throw unavailable("socket_invalid");
  }
};

const makeLaunchDirectory = (
  runtimeRoot: string,
): Effect.Effect<string, PluginUnavailableFailure> =>
  Effect.tryPromise({
    catch: () => unavailable("socket_invalid"),
    try: async () => hardenLaunchDirectory(await mkdtemp(join(runtimeRoot, "p-"))),
  });

export { makeLaunchDirectory, makeRuntimeRoot, pluginSocketPath, removePath };
