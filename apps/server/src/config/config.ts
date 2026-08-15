import { Context, Effect, FileSystem, Layer } from "effect";
import { TomlError, parse } from "smol-toml";

import { ConfigParseError, ConfigReadError } from "./errors.ts";
import { applyContentOverrides } from "./overlay.ts";
import type { Environment } from "./overlay.ts";
import { decodeConfiguration } from "./schema.ts";
import type { ConfigService } from "./schema.ts";

const DEFAULT_CONFIG_PATH = "/etc/nama/nama.toml";
const contextService = Context.Service;

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
    const overlaid = applyContentOverrides(parsed, environment);

    return yield* decodeConfiguration(overlaid);
  });

class Config extends contextService<Config, ConfigService>()("@nama/server/Config") {
  static readonly layer = (environment: Environment) =>
    Layer.effect(Config, loadConfig(environment));
}

export { Config };
