import { createHash } from "node:crypto";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

const RESTART_MUTATING_TEST =
  "integration/tests/jellyfin-real-provider.process.integration.test.ts";
const SHARED_JELLYFIN_TESTS = [
  "integration/tests/provider-durable-loop.process.integration.test.ts",
  "integration/tests/universal-browse-flow.process.integration.test.ts",
  RESTART_MUTATING_TEST,
] as const;
const DEFAULT_SHUFFLE_SEED = 0;
const configuredSeed = process.env["NAMA_TEST_SHUFFLE_SEED"];
const shuffleSeed = (() => {
  if (configuredSeed === undefined) {
    return configuredSeed;
  }
  if (!/^-?\d+$/u.test(configuredSeed)) {
    throw new Error("NAMA_TEST_SHUFFLE_SEED must be an integer");
  }
  return Math.trunc(Number(configuredSeed));
})();

class RestartLastSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const ordered = files.map((file) => {
      const path = relative(import.meta.dirname, file.moduleId);
      let key = path;
      if (shuffleSeed !== undefined) {
        key = createHash("sha256").update(`${shuffleSeed}:${path}`).digest("hex");
      }
      return { file, key, path };
    });
    return Promise.resolve(
      ordered
        .toSorted(
          (left, right) =>
            Number(left.path === RESTART_MUTATING_TEST) -
              Number(right.path === RESTART_MUTATING_TEST) || left.key.localeCompare(right.key),
        )
        .map(({ file }) => file),
    );
  }
}

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          exclude: [...SHARED_JELLYFIN_TESTS],
          include: ["src/**/tests/**/*.test.ts", "integration/tests/**/*.test.ts"],
          maxWorkers: 2,
          name: "parallel",
          pool: "forks",
        },
      },
      {
        extends: true,
        test: {
          fileParallelism: false,
          include: [...SHARED_JELLYFIN_TESTS],
          maxWorkers: 1,
          name: "shared-jellyfin",
          pool: "forks",
        },
      },
    ],
    reporters: [
      "default",
      fileURLToPath(new URL("../../scripts/vitest-health-reporter.mjs", import.meta.url)),
    ],
    retry: 0,
    sequence: {
      seed: shuffleSeed ?? DEFAULT_SHUFFLE_SEED,
      sequencer: RestartLastSequencer,
      shuffle: shuffleSeed !== undefined,
    },
  },
});
