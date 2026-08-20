// fallow-ignore-file unused-file -- The durable provider tracer preloads this test-only override by absolute path.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- Oxlint cannot recover Node types for this disposable preload fixture.

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const mode = process.env.NAMA_TEST_BUNDLED_PLUGIN_MODE;
const controlDirectory = process.env.NAMA_TEST_BUNDLED_PLUGIN_CONTROL_DIRECTORY;

if (mode === undefined || controlDirectory === undefined) {
  throw new Error("bundled plugin override configuration is required");
}

const bundledJellyfinEntrypointSuffix = "/plugins/jellyfin/src/main.ts";
const fixturePath = join(import.meta.dirname, "plugin-subprocess.mjs");
const missingExecutablePath = join(controlDirectory, "absent-bundled-jellyfin-plugin");
const originalSpawn = childProcess.spawn;
const JELLYFIN_LAUNCH_ARGUMENT_COUNT = 1;
const JELLYFIN_ENTRYPOINT_ARGUMENT_INDEX = 0;

const spawn = (executable, arguments_, options) => {
  const jellyfinLaunch =
    executable === process.execPath &&
    Array.isArray(arguments_) &&
    arguments_.length === JELLYFIN_LAUNCH_ARGUMENT_COUNT &&
    arguments_[JELLYFIN_ENTRYPOINT_ARGUMENT_INDEX]?.endsWith(bundledJellyfinEntrypointSuffix) ===
      true;
  if (!jellyfinLaunch) {
    return originalSpawn(executable, arguments_, options);
  }
  if (mode === "absent") {
    return originalSpawn(missingExecutablePath, [], options);
  }
  return originalSpawn(process.execPath, [fixturePath, controlDirectory, mode], options);
};

childProcess.spawn = spawn;
syncBuiltinESMExports();
