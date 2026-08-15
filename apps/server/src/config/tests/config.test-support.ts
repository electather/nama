import { NodeFileSystem } from "@effect/platform-node";
import { expect } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { Config } from "../config.ts";

const MASTER_KEY_FILL = 7;

const DATABASE_URL = "postgres://nama:database-secret@127.0.0.1:5432/nama";
const DEFAULT_CONFIG_PATH = "/etc/nama/nama.toml";
const MASTER_KEY_BYTES = 32;
const MAXIMUM_BYTE = 255;
const BYTE_LENGTH_OFFSET = 1;
const DEFAULT_MAX_CONNECTIONS = 10;
const MINIMUM_CONNECTIONS = 1;
const MAXIMUM_CONNECTIONS = 100;
const MASTER_KEY = `base64:${Buffer.alloc(MASTER_KEY_BYTES, MASTER_KEY_FILL).toString("base64")}`;

interface TomlSections {
  readonly database?: string;
  readonly logging?: string;
  readonly security?: string;
  readonly server?: string;
}

const validToml = ({
  database = `url = "${DATABASE_URL}"`,
  logging = "",
  security = `master_key = "${MASTER_KEY}"`,
  server = 'public_url = "https://nama.example"',
}: TomlSections = {}): string => {
  let loggingSection = "";
  if (logging !== "") {
    loggingSection = `\n[logging]\n${logging}\n`;
  }
  return `[server]\n${server}\n\n[database]\n${database}\n\n[security]\n${security}\n${loggingSection}`;
};

const readConfig = Effect.gen(function* readConfigService() {
  return yield* Config;
});

const configProgram = (environment: Readonly<Record<string, string | undefined>>) =>
  readConfig.pipe(Effect.provide(Config.layer(environment)), Effect.provide(NodeFileSystem.layer));

const runConfigFailure = (environment: Readonly<Record<string, string | undefined>>) =>
  configProgram(environment).pipe(Effect.flip);

const runConfig = (environment: Readonly<Record<string, string | undefined>>) =>
  configProgram(environment);

const withTemporaryDirectory = <Result, Error, Requirements>(
  use: (directory: string) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.gen(function* temporaryDirectory() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "nama-config-" });
    return yield* use(directory);
  }).pipe(Effect.provide(NodeFileSystem.layer));

const withConfig = <Result, Error, Requirements>(
  toml: string,
  use: (path: string) => Effect.Effect<Result, Error, Requirements>,
) =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* temporaryConfig() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = `${directory}/nama.toml`;
      yield* fileSystem.writeFileString(path, toml);
      return yield* use(path);
    }),
  );

const loadToml = (toml: string, overrides: Readonly<Record<string, string | undefined>> = {}) =>
  withConfig(toml, (path) => runConfig({ NAMA_CONFIG: path, ...overrides }));

const rejectToml = (toml: string, overrides: Readonly<Record<string, string | undefined>> = {}) =>
  withConfig(toml, (path) => runConfigFailure({ NAMA_CONFIG: path, ...overrides }));

const expectValidationError = <Result, Error, Requirements>(
  failure: Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.gen(function* validationErrorAssertion() {
    const error = yield* failure;
    expect(error).toMatchObject({ _tag: "ConfigValidationError" });
  });

export {
  BYTE_LENGTH_OFFSET,
  DATABASE_URL,
  DEFAULT_CONFIG_PATH,
  DEFAULT_MAX_CONNECTIONS,
  MASTER_KEY,
  MASTER_KEY_BYTES,
  MAXIMUM_BYTE,
  MAXIMUM_CONNECTIONS,
  MINIMUM_CONNECTIONS,
  expectValidationError,
  loadToml,
  rejectToml,
  runConfigFailure,
  validToml,
  withTemporaryDirectory,
};
export type { TomlSections };
