import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import {
  DATABASE_URL,
  DEFAULT_CONFIG_PATH,
  DEFAULT_MAX_CONNECTIONS,
  MASTER_KEY,
  MASTER_KEY_BYTES,
  expectValidationError,
  loadToml,
  rejectToml,
  runConfigFailure,
  validToml,
  withTemporaryDirectory,
} from "./config.test-support.ts";

const OVERRIDE_KEY_FILL = 9;
const OVERRIDE_MASTER_KEY = `base64:${Buffer.alloc(MASTER_KEY_BYTES, OVERRIDE_KEY_FILL).toString("base64")}`;
const OVERRIDE_DATABASE_URL = "postgres://override:secret@db/override";
const OVERRIDE_BIND = "127.0.0.1:9090";
const OVERRIDE_PUBLIC_URL = "http://localhost:9090";
const NORMALIZED_OVERRIDE_PUBLIC_URL = "http://localhost:9090/";

const revealedValue = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) {
    return Redacted.value(value);
  }
  return value;
};

it.effect("loads required values and applies every default", () =>
  Effect.gen(function* defaultConfigurationTest() {
    const config = yield* loadToml(validToml());

    expect(config.server).toEqual({
      bind: "0.0.0.0:8080",
      lanDiscovery: true,
      publicUrl: "https://nama.example/",
    });
    expect(config.database.maxConnections).toBe(DEFAULT_MAX_CONNECTIONS);
    expect(config.logging.level).toBe("info");
  }),
);

it.effect("loads file-only LAN discovery without an environment override", () =>
  Effect.gen(function* fileOnlyLanDiscoveryTest() {
    const server = 'public_url = "https://nama.example"\nlan_discovery = false';
    const disabled = yield* loadToml(validToml({ server }));
    const ignoredEnvironment = yield* loadToml(validToml(), {
      NAMA_LAN_DISCOVERY: "false",
    });

    expect(disabled.server.lanDiscovery).toBe(false);
    expect(ignoredEnvironment.server.lanDiscovery).toBe(true);
  }),
);

it.effect("selects the default file only when NAMA_CONFIG is absent", () =>
  Effect.gen(function* configSelectionTest() {
    const missingDefault = yield* runConfigFailure({});
    const emptySelectedPath = yield* runConfigFailure({ NAMA_CONFIG: "" });

    expect(missingDefault).toMatchObject({ _tag: "ConfigReadError" });
    expect(emptySelectedPath).toMatchObject({ _tag: "ConfigReadError" });
    expect(JSON.stringify([missingDefault, emptySelectedPath])).not.toContain(DEFAULT_CONFIG_PATH);
  }),
);

it.effect("normalizes missing and unreadable files without retaining their paths", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* configReadFailureTest() {
      const missingPath = `${directory}/nama-does-not-exist-secret.toml`;
      const missing = yield* runConfigFailure({ NAMA_CONFIG: missingPath });
      const unreadable = yield* runConfigFailure({ NAMA_CONFIG: directory });

      expect(missing).toMatchObject({ _tag: "ConfigReadError" });
      expect(unreadable).toMatchObject({ _tag: "ConfigReadError" });
      expect(JSON.stringify([missing, unreadable])).not.toContain(missingPath);
    }),
  ),
);

it.effect("reports malformed TOML location without retaining source text", () =>
  Effect.gen(function* malformedTomlTest() {
    const secretSource = '[server]\npublic_url = "https://secret.example"\nbroken = "';
    const error = yield* rejectToml(secretSource);

    expect(error).toMatchObject({ _tag: "ConfigParseError" });
    expect(error).toHaveProperty("line");
    expect(error).toHaveProperty("column");
    expect(JSON.stringify(error)).not.toContain("secret.example");
  }),
);

it.effect("rejects unknown configuration keys", () =>
  expectValidationError(rejectToml(`unknown = "root"\n${validToml()}`)),
);

it.effect.each([
  ["server", validToml({ server: "" })],
  ["database", validToml({ database: "" })],
  ["security", validToml({ security: "" })],
] as const)("rejects a missing %s field", ([_section, toml]) =>
  expectValidationError(rejectToml(toml)),
);

it.effect.each([
  [
    "database",
    "NAMA_DATABASE_URL",
    OVERRIDE_DATABASE_URL,
    "database",
    "url",
    OVERRIDE_DATABASE_URL,
  ],
  [
    "master key",
    "NAMA_MASTER_KEY",
    OVERRIDE_MASTER_KEY,
    "security",
    "masterKey",
    OVERRIDE_MASTER_KEY,
  ],
  ["bind", "NAMA_BIND", OVERRIDE_BIND, "server", "bind", OVERRIDE_BIND],
  [
    "public URL",
    "NAMA_PUBLIC_URL",
    OVERRIDE_PUBLIC_URL,
    "server",
    "publicUrl",
    NORMALIZED_OVERRIDE_PUBLIC_URL,
  ],
  ["log level", "NAMA_LOG_LEVEL", "debug", "logging", "level", "debug"],
] as const)("applies the %s override", ([_label, name, value, section, field, expected]) =>
  Effect.gen(function* configurationOverrideTest() {
    const config = yield* loadToml(validToml(), { [name]: value });
    const sectionValue = Reflect.get(config, section) as object;
    const decoded = Reflect.get(sectionValue, field) as unknown;
    expect(revealedValue(decoded)).toBe(expected);
  }),
);

it.effect.each([
  "NAMA_DATABASE_URL",
  "NAMA_MASTER_KEY",
  "NAMA_BIND",
  "NAMA_PUBLIC_URL",
  "NAMA_LOG_LEVEL",
])("treats an empty %s override as present invalid input", (name) =>
  expectValidationError(rejectToml(validToml(), { [name]: "" })),
);

it.effect("ignores unlisted environment variables", () =>
  Effect.gen(function* ignoredEnvironmentTest() {
    const config = yield* loadToml(validToml(), {
      NAMA_DATABASE_MAX_CONNECTIONS: "99",
      NAMA_UNKNOWN: "changed",
    });

    expect(config.database.maxConnections).toBe(DEFAULT_MAX_CONNECTIONS);
  }),
);

it.effect("returns frozen configuration with redacted secrets", () =>
  Effect.gen(function* immutableConfigurationTest() {
    const config = yield* loadToml(validToml());

    expect(Redacted.isRedacted(config.database.url)).toBe(true);
    expect(Redacted.isRedacted(config.security.masterKey)).toBe(true);
    expect(Redacted.value(config.database.url)).toBe(DATABASE_URL);
    expect(Redacted.value(config.security.masterKey)).toBe(MASTER_KEY);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.server)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.security)).toBe(true);
    expect(Object.isFrozen(config.logging)).toBe(true);
  }),
);
