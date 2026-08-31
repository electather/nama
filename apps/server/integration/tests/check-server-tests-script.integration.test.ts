import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, test } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const SUCCESS_EXIT_CODE = 0;
const USAGE_EXIT_CODE = 64;
const UNKNOWN_EXIT_CODE = -1;
const DOCKER_FIXTURE = `#!/bin/sh
case " $* " in
  *" run --rm "*) exit 0 ;;
  *" down "*) exit 0 ;;
  *" up --detach --wait postgres "*) exit 0 ;;
  *" port postgres 5432 "*) printf '127.0.0.1:54321\\n'; exit 0 ;;
  *" up --detach --wait jellyfin "*) printf 'Jellyfin fixture failed\\n' >&2; exit 1 ;;
  *) printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 99 ;;
esac
`;
const AVAILABLE_DOCKER_FIXTURE = `#!/bin/sh
case " $* " in
  *" run --rm "*) exit 0 ;;
  *" down "*) exit 0 ;;
  *" up --detach --wait postgres "*) exit 0 ;;
  *" port postgres 5432 "*) printf '127.0.0.1:54321\\n'; exit 0 ;;
  *" up --detach --wait jellyfin "*) exit 0 ;;
  *" port jellyfin 8096 "*) printf '127.0.0.1:58096\\n'; exit 0 ;;
  *) printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 99 ;;
esac
`;
const PNPM_FIXTURE = `#!/bin/sh
if [ "\${NAMA_TEST_JELLYFIN_URL+x}" = x ]; then
  printf 'PNPM_JELLYFIN_URL=%s\\n' "$NAMA_TEST_JELLYFIN_URL"
else
  printf 'PNPM_JELLYFIN_URL=unset\\n'
fi
printf 'PNPM_ARGS=%s\\n' "$*"
`;

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

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

const runServerCheck = async (
  fixtureDirectory: string,
  testPaths: readonly string[] = [
    "integration/tests/jellyfin-real-provider.process.integration.test.ts",
  ],
): Promise<ProcessResult> => {
  const child = spawn(
    "/bin/bash",
    [join(REPOSITORY_ROOT, "scripts/check-server-tests.sh"), ...testPaths],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        NAMA_TEST_JELLYFIN_URL: "http://stale-jellyfin.invalid/",
        PATH: `${fixtureDirectory}:${process.env["PATH"] ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = readText(child.stdout);
  const stderr = readText(child.stderr);
  await once(child, "close");
  return {
    exitCode: child.exitCode ?? UNKNOWN_EXIT_CODE,
    stderr: await stderr,
    stdout: await stdout,
  };
};

test("reports an unavailable Jellyfin container as an unrun provider proof", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "nama-server-check-"));
  try {
    await Promise.all([
      writeFile(join(fixtureDirectory, "docker"), DOCKER_FIXTURE, { mode: 0o700 }),
      writeFile(join(fixtureDirectory, "pnpm"), PNPM_FIXTURE, { mode: 0o700 }),
    ]);

    const result = await runServerCheck(fixtureDirectory);

    expect(result.exitCode).toBe(SUCCESS_EXIT_CODE);
    expect(result.stdout).toContain("PNPM_JELLYFIN_URL=unset");
    expect(result.stderr).toContain(
      "Jellyfin unavailable; real-provider proof will be reported as skipped",
    );
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("runs the restart-mutating Jellyfin proof after every other server test", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "nama-server-check-"));
  try {
    await Promise.all([
      writeFile(join(fixtureDirectory, "docker"), AVAILABLE_DOCKER_FIXTURE, { mode: 0o700 }),
      writeFile(join(fixtureDirectory, "pnpm"), PNPM_FIXTURE, { mode: 0o700 }),
    ]);

    const result = await runServerCheck(fixtureDirectory, []);

    expect(result.exitCode).toBe(SUCCESS_EXIT_CODE);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("PNPM_ARGS="))).toEqual([
      `PNPM_ARGS=--dir ${REPOSITORY_ROOT} --filter @nama/server exec vitest run --exclude integration/tests/jellyfin-real-provider.process.integration.test.ts`,
      `PNPM_ARGS=--dir ${REPOSITORY_ROOT} --filter @nama/server exec vitest run integration/tests/jellyfin-real-provider.process.integration.test.ts`,
    ]);
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("rejects ambiguous Vitest arguments instead of co-running the restart proof", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "nama-server-check-"));
  try {
    await Promise.all([
      writeFile(join(fixtureDirectory, "docker"), AVAILABLE_DOCKER_FIXTURE, { mode: 0o700 }),
      writeFile(join(fixtureDirectory, "pnpm"), PNPM_FIXTURE, { mode: 0o700 }),
    ]);

    const result = await runServerCheck(fixtureDirectory, ["--reporter=verbose"]);

    expect(result.exitCode).toBe(USAGE_EXIT_CODE);
    expect(result.stdout).not.toContain("PNPM_ARGS=");
    expect(result.stderr).toContain("server test filters must be exact integration test paths");
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("keeps the restart proof last when it is one of several selected tests", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "nama-server-check-"));
  try {
    await Promise.all([
      writeFile(join(fixtureDirectory, "docker"), AVAILABLE_DOCKER_FIXTURE, { mode: 0o700 }),
      writeFile(join(fixtureDirectory, "pnpm"), PNPM_FIXTURE, { mode: 0o700 }),
    ]);

    const result = await runServerCheck(fixtureDirectory, [
      "integration/tests/jellyfin-artwork.process.integration.test.ts",
      "integration/tests/jellyfin-real-provider.process.integration.test.ts",
    ]);

    expect(result.exitCode).toBe(SUCCESS_EXIT_CODE);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("PNPM_ARGS="))).toEqual([
      `PNPM_ARGS=--dir ${REPOSITORY_ROOT} --filter @nama/server exec vitest run --exclude integration/tests/jellyfin-real-provider.process.integration.test.ts integration/tests/jellyfin-artwork.process.integration.test.ts`,
      `PNPM_ARGS=--dir ${REPOSITORY_ROOT} --filter @nama/server exec vitest run integration/tests/jellyfin-real-provider.process.integration.test.ts`,
    ]);
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});
