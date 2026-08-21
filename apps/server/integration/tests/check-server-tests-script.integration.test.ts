import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, test } from "vitest";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const SUCCESS_EXIT_CODE = 0;
const UNKNOWN_EXIT_CODE = -1;
const DOCKER_FIXTURE = `#!/bin/sh
case " $* " in
  *" down "*) exit 0 ;;
  *" up --detach --wait postgres "*) exit 0 ;;
  *" port postgres 5432 "*) printf '127.0.0.1:54321\\n'; exit 0 ;;
  *" up --detach --wait jellyfin "*) printf 'Jellyfin fixture failed\\n' >&2; exit 1 ;;
  *) printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 99 ;;
esac
`;
const PNPM_FIXTURE = `#!/bin/sh
if [ "\${NAMA_TEST_JELLYFIN_URL+x}" = x ]; then
  printf 'PNPM_JELLYFIN_URL=%s\\n' "$NAMA_TEST_JELLYFIN_URL"
else
  printf 'PNPM_JELLYFIN_URL=unset\\n'
fi
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

const runServerCheck = async (fixtureDirectory: string): Promise<ProcessResult> => {
  const child = spawn(
    "/bin/bash",
    [
      join(REPOSITORY_ROOT, "scripts/check-server-tests.sh"),
      "integration/tests/jellyfin-real-provider.process.integration.test.ts",
    ],
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
