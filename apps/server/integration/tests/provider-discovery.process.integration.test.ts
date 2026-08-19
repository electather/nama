// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, typescript/consistent-return, typescript/strict-void-return -- This executable flow keeps the administrator-visible CLI, server, PostgreSQL, and plugin boundary in one ordered scenario.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { startProcess } from "./process.test-support.ts";

const execFilePromise = promisify(execFile);
const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const TEST_TIMEOUT_MILLISECONDS = 30_000;
const ADMINISTRATOR = Object.freeze({
  displayName: "Provider Discovery Administrator",
  email: "provider-discovery@example.test",
  password: "provider-discovery-password",
});

interface NamaResult {
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
      const directory = await mkdtemp(join(tmpdir(), "nama-provider-discovery-"));
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

const runNama = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): Effect.Effect<NamaResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const result = await execFilePromise(binary, arguments_, {
        cwd: REPOSITORY_ROOT,
        env: environment,
      });
      return { stderr: result.stderr, stdout: result.stdout };
    },
  });

it.live(
  "lists production-reconciled Jellyfin provider metadata through the compiled CLI",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      withNamaBinary(({ binary, home }) =>
        Effect.gen(function* providerDiscoveryProcessTest() {
          const runningProcess = yield* startProcess(databaseUrl);
          yield* expectReady(runningProcess);
          const clients = clientsFor(runningProcess.origin);
          yield* expectRpcSuccess({
            invoke: () =>
              clients.setup.createAdministrator(
                {
                  bootstrapToken: bootstrapTokenFrom(runningProcess),
                  displayName: ADMINISTRATOR.displayName,
                  email: ADMINISTRATOR.email,
                  password: ADMINISTRATOR.password,
                },
                callOptions(),
              ),
            phase: "CreateAdministrator",
          });
          const signIn = yield* expectRpcSuccess({
            invoke: () =>
              clients.authentication.signIn(
                { email: ADMINISTRATOR.email, password: ADMINISTRATOR.password },
                callOptions(),
              ),
            phase: "SignIn",
          });
          const token = signIn.credential?.token;
          if (token === undefined || token.length === 0) {
            return yield* Effect.die(new Error("expected a signed administrator credential"));
          }
          const environment = cliEnvironment(home, token);
          yield* runNama(binary, environment, [
            "profile",
            "set",
            "local",
            "--server",
            runningProcess.origin,
            "--output",
            "json",
          ]);

          const human = yield* runNama(binary, environment, [
            "provider",
            "type",
            "list",
            "--profile",
            "local",
          ]);
          const json = yield* runNama(binary, environment, [
            "provider",
            "type",
            "list",
            "--profile",
            "local",
            "--output",
            "json",
          ]);

          expect(human.stderr).toContain("Plain HTTP is not encrypted.");
          expect(human.stdout).toContain("jellyfin");
          expect(json.stderr).toBe("");
          expect(json.stdout).not.toContain(token);
          const payload: unknown = JSON.parse(json.stdout);
          if (typeof payload !== "object" || payload === null || !("data" in payload)) {
            return yield* Effect.die(new Error("expected a CLI data envelope"));
          }
          expect(payload.data).toEqual({
            provider_types: [
              {
                capabilities: [],
                configuration_schema: {
                  additionalProperties: false,
                  properties: {
                    api_key: {
                      format: "password",
                      maxLength: 4096,
                      minLength: 1,
                      title: "API key",
                      type: "string",
                      writeOnly: true,
                      "x-nama-order": 3,
                    },
                    base_url: {
                      format: "uri",
                      maxLength: 2048,
                      minLength: 1,
                      title: "Base URL",
                      type: "string",
                      "x-nama-order": 1,
                    },
                    user_id: {
                      maxLength: 128,
                      minLength: 1,
                      title: "User ID",
                      type: "string",
                      "x-nama-order": 2,
                    },
                  },
                  required: ["base_url", "user_id", "api_key"],
                  type: "object",
                },
                description: "Connect Nama to a Jellyfin server.",
                display_name: "Jellyfin",
                id: "jellyfin",
                schema_profile_version: 1,
                schema_revision: "1",
              },
            ],
          });
          expect(runningProcess.stdout()).not.toContain(token);
          expect(runningProcess.stderr()).not.toContain(token);
          yield* stopCleanly(runningProcess);
        }),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
