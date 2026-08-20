import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
// oxlint-disable-next-line typescript/strict-void-return -- Node's overloaded callback API needs promisify's value-returning adapter for the compiled CLI build.
const execFilePromise = promisify(execFile);
const UNKNOWN_EXIT_CODE = -1;

interface NamaResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const withNamaBinary = <Success, Failure, Requirements>(
  use: (
    input: Readonly<{ binary: string; home: string }>,
  ) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "nama-provider-durable-loop-"));
      const binary = join(directory, "nama");
      await execFilePromise("go", ["build", "-o", binary, "./apps/cli/cmd/nama"], {
        cwd: REPOSITORY_ROOT,
      });
      return { binary, directory, home: join(directory, "home") };
    }),
    use,
    ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );

const cliEnvironment = (home: string, token: string): NodeJS.ProcessEnv => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("NAMA_")),
  );
  return {
    ...environment,
    APPDATA: home,
    HOME: home,
    NAMA_TOKEN: token,
    XDG_CONFIG_HOME: home,
  };
};

// oxlint-disable-next-line eslint/max-params -- The subprocess seam deliberately exposes binary, environment, argv, and optional stdin as distinct operating-system channels.
const runNama = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
  input?: string,
): Effect.Effect<NamaResult, Error> =>
  Effect.callback<NamaResult, Error>((resume) => {
    const child = spawn(binary, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      resume(Effect.fail(error));
    });
    child.once("close", (exitCode) => {
      resume(
        Effect.succeed({
          exitCode: exitCode ?? UNKNOWN_EXIT_CODE,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        }),
      );
    });
    child.stdin.end(input);
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
  });

const dataFromNama = (result: NamaResult): Readonly<Record<string, unknown>> => {
  const payload: unknown = JSON.parse(result.stdout);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("data" in payload) ||
    typeof payload.data !== "object" ||
    payload.data === null ||
    Array.isArray(payload.data)
  ) {
    throw new TypeError("expected a Nama data envelope");
  }
  return Object.fromEntries(Object.entries(payload.data));
};

const providerInstanceFromNama = (result: NamaResult): Readonly<Record<string, unknown>> => {
  const providerInstance = dataFromNama(result)["provider_instance"];
  if (
    typeof providerInstance !== "object" ||
    providerInstance === null ||
    Array.isArray(providerInstance)
  ) {
    throw new TypeError("expected a provider instance");
  }
  return Object.fromEntries(Object.entries(providerInstance));
};

export { cliEnvironment, dataFromNama, providerInstanceFromNama, runNama, withNamaBinary };
export type { NamaResult };
