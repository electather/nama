import { spawn } from "node:child_process";
import { once } from "node:events";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, test } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const SERVER_ROOT = join(REPOSITORY_ROOT, "apps/server");
const SHARED_JELLYFIN_TESTS = [
  "integration/tests/jellyfin-real-provider.process.integration.test.ts",
  "integration/tests/provider-durable-loop.process.integration.test.ts",
  "integration/tests/universal-browse-flow.process.integration.test.ts",
] as const;
const SUCCESS_EXIT_CODE = 0;

const readText = async (stream: Readable): Promise<string> => {
  stream.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of stream) {
    if (typeof chunk !== "string") {
      throw new TypeError("expected UTF-8 process output");
    }
    chunks.push(chunk);
  }
  return chunks.join("");
};

const listProject = async (project: string): Promise<string[]> => {
  const child = spawn(
    "pnpm",
    [
      "--dir",
      REPOSITORY_ROOT,
      "--filter",
      "@nama/server",
      "exec",
      "vitest",
      "list",
      "--filesOnly",
      "--project",
      project,
    ],
    { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = readText(child.stdout);
  const stderr = readText(child.stderr);
  await once(child, "close");
  if (child.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(await stderr);
  }
  const output = await stdout;
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\[[^\]]+\] /u, ""))
    .toSorted();
};

test("assigns every server test file to exactly one bounded worker project", async () => {
  const inventory: string[] = [];
  for await (const path of glob(["src/**/tests/**/*.test.ts", "integration/tests/**/*.test.ts"], {
    cwd: SERVER_ROOT,
  })) {
    inventory.push(path);
  }

  const [parallel, sharedJellyfin] = await Promise.all([
    listProject("parallel"),
    listProject("shared-jellyfin"),
  ]);
  const parallelPaths = new Set(parallel);

  expect(sharedJellyfin).toEqual(SHARED_JELLYFIN_TESTS);
  expect(sharedJellyfin.filter((path) => parallelPaths.has(path))).toEqual([]);
  expect([...parallel, ...sharedJellyfin].toSorted()).toEqual(inventory.toSorted());
});
