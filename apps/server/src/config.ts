import { isIPv4, isIPv6 } from "node:net";

import { Context, Data, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { Redacted as RedactedValue } from "effect/Redacted";
import { TomlError, parse } from "smol-toml";

const DEFAULT_CONFIG_PATH = "/etc/nama/nama.toml";
const DEFAULT_BIND = "0.0.0.0:8080";
const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_LOG_LEVEL = "info";
const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;
const MAXIMUM_HOSTNAME_LENGTH = 253;
const MAXIMUM_HOSTNAME_LABEL_LENGTH = 63;
const MASTER_KEY_BYTES = 32;
const MINIMUM_CONNECTIONS = 1;
const MAXIMUM_CONNECTIONS = 100;
const FIRST_INDEX = 0;
const NEXT_CHARACTER_OFFSET = 1;

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

type LogLevel = (typeof LOG_LEVELS)[number];
type Environment = Readonly<Record<string, string | undefined>>;

interface ConfigService {
  readonly server: Readonly<{
    readonly bind: string;
    readonly publicUrl: string;
  }>;
  readonly database: Readonly<{
    readonly url: RedactedValue;
    readonly maxConnections: number;
  }>;
  readonly security: Readonly<{
    readonly masterKey: RedactedValue;
  }>;
  readonly logging: Readonly<{
    readonly level: LogLevel;
  }>;
}

const taggedError = Data.TaggedError;
const contextService = Context.Service;
const ConfigReadError = taggedError("ConfigReadError");
const ConfigParseError = taggedError("ConfigParseError")<{
  readonly column?: number;
  readonly line?: number;
}>;
const ConfigValidationError = taggedError("ConfigValidationError")<{
  readonly fieldPath?: string;
}>;

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

const hasValidPort = (value: string): boolean => {
  if (!/^\d+$/u.test(value)) {
    return false;
  }
  const port = Number(value);
  return port >= MINIMUM_PORT && port <= MAXIMUM_PORT;
};

const isValidHostname = (value: string): boolean => {
  if (value === "" || value.length > MAXIMUM_HOSTNAME_LENGTH) {
    return false;
  }
  return value
    .split(".")
    .every(
      (label) =>
        label !== "" &&
        label.length <= MAXIMUM_HOSTNAME_LABEL_LENGTH &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label),
    );
};

const isValidIpv6Bind = (value: string): boolean => {
  const match = /^\[(?<host>.+)\]:(?<port>\d+)$/u.exec(value);
  return (
    match?.groups !== undefined &&
    isIPv6(match.groups["host"] ?? "") &&
    hasValidPort(match.groups["port"] ?? "")
  );
};

const isValidHostBind = (value: string): boolean => {
  const separator = value.lastIndexOf(":");
  if (separator <= FIRST_INDEX || value.indexOf(":") !== separator) {
    return false;
  }
  const host = value.slice(FIRST_INDEX, separator);
  const port = value.slice(separator + NEXT_CHARACTER_OFFSET);
  if (!hasValidPort(port)) {
    return false;
  }
  if (/^\d+(?:\.\d+){3}$/u.test(host)) {
    return isIPv4(host);
  }
  return isValidHostname(host);
};

const isValidBind = (value: string): boolean => {
  if (value.startsWith("[")) {
    return isValidIpv6Bind(value);
  }
  return isValidHostBind(value);
};

const isValidPublicUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const isValidMasterKey = (value: string): boolean => {
  if (!value.startsWith("base64:")) {
    return false;
  }
  const encoded = value.slice("base64:".length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return false;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === MASTER_KEY_BYTES && decoded.toString("base64") === encoded;
};

const bindIssue = (value: string) => isValidBind(value) || "invalid bind address";
const publicUrlIssue = (value: string) => isValidPublicUrl(value) || "invalid public URL";
const masterKeyIssue = (value: string) => isValidMasterKey(value) || "invalid master key";
const BindSchema = Schema.String.check(Schema.makeFilter<string>(bindIssue));
const PublicUrlSchema = Schema.String.check(Schema.makeFilter<string>(publicUrlIssue));
const DatabaseUrlSchema = Schema.NonEmptyString;
const MasterKeySchema = Schema.String.check(Schema.makeFilter<string>(masterKeyIssue));
const MaxConnectionsSchema = Schema.Int.check(
  Schema.isBetween({ maximum: MAXIMUM_CONNECTIONS, minimum: MINIMUM_CONNECTIONS }),
);
const LogLevelSchema = Schema.Literals(LOG_LEVELS);

const bindWithDefault = BindSchema.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BIND)),
);
const connectionsWithDefault = MaxConnectionsSchema.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_CONNECTIONS)),
);
const levelWithDefault = LogLevelSchema.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_LOG_LEVEL)),
);
const loggingWithDefault = Schema.Struct({ level: levelWithDefault }).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const ConfigurationSchema = Schema.Struct({
  database: Schema.Struct({
    max_connections: connectionsWithDefault,
    url: Schema.RedactedFromValue(DatabaseUrlSchema, { label: "database.url" }),
  }),
  logging: loggingWithDefault,
  security: Schema.Struct({
    master_key: Schema.RedactedFromValue(MasterKeySchema, { label: "security.master_key" }),
  }),
  server: Schema.Struct({
    bind: bindWithDefault,
    public_url: PublicUrlSchema,
  }),
});

type DecodedConfiguration = Schema.Schema.Type<typeof ConfigurationSchema>;

type FieldOverride = readonly [field: string, value: string | undefined];

const copySectionWithOverrides = (
  root: Readonly<Record<string, unknown>>,
  name: string,
  overrides: readonly FieldOverride[],
): unknown => {
  const original = root[name];
  const decoded = decodeRecord(original);
  if (Option.isNone(decoded) && original !== undefined) {
    return original;
  }
  const section: Record<string, unknown> = Option.match(decoded, {
    onNone: () => ({}),
    onSome: (value) => ({ ...value }),
  });
  for (const [field, value] of overrides) {
    if (value !== undefined) {
      section[field] = value;
    }
  }
  return section;
};

const applyContentOverrides = (input: unknown, environment: Environment): unknown => {
  const root = decodeRecord(input);
  if (Option.isNone(root)) {
    return input;
  }
  return {
    ...root.value,
    database: copySectionWithOverrides(root.value, "database", [
      ["url", environment["NAMA_DATABASE_URL"]],
    ]),
    logging: copySectionWithOverrides(root.value, "logging", [
      ["level", environment["NAMA_LOG_LEVEL"]],
    ]),
    security: copySectionWithOverrides(root.value, "security", [
      ["master_key", environment["NAMA_MASTER_KEY"]],
    ]),
    server: copySectionWithOverrides(root.value, "server", [
      ["bind", environment["NAMA_BIND"]],
      ["public_url", environment["NAMA_PUBLIC_URL"]],
    ]),
  };
};

const parseConfiguration = (source: string) =>
  Effect.try({
    catch: (error) => {
      if (error instanceof TomlError) {
        return new ConfigParseError({ column: error.column, line: error.line });
      }
      return new ConfigParseError({});
    },
    try: () => parse(source) as unknown,
  });

const decodeConfiguration = (input: unknown) =>
  Schema.decodeUnknownEffect(ConfigurationSchema, {
    errors: "all",
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new ConfigValidationError({})));

const freezeConfiguration = (decoded: Readonly<DecodedConfiguration>): ConfigService => {
  const database = Object.freeze({
    maxConnections: decoded.database.max_connections,
    url: decoded.database.url,
  });
  const logging = Object.freeze({ level: decoded.logging.level });
  const security = Object.freeze({ masterKey: decoded.security.master_key });
  const server = Object.freeze({
    bind: decoded.server.bind,
    publicUrl: new URL(decoded.server.public_url).toString(),
  });
  return Object.freeze({ database, logging, security, server });
};

const loadConfig = (environment: Environment) =>
  Effect.gen(function* loadConfiguration() {
    const path = environment["NAMA_CONFIG"] ?? DEFAULT_CONFIG_PATH;
    if (path === "") {
      return yield* new ConfigReadError(undefined);
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.mapError(() => new ConfigReadError(undefined)));
    const parsed = yield* parseConfiguration(source);
    const decoded = yield* decodeConfiguration(applyContentOverrides(parsed, environment));

    return freezeConfiguration(decoded);
  });

class Config extends contextService<Config, ConfigService>()("@nama/server/Config") {
  static readonly layer = (environment: Environment) =>
    Layer.effect(Config, loadConfig(environment));
}

export { Config };
