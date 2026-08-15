import { Data } from "effect";

const taggedError = Data.TaggedError;

const ConfigReadError = taggedError("ConfigReadError");
const ConfigParseError = taggedError("ConfigParseError")<{
  readonly column?: number;
  readonly line?: number;
}>;
const ConfigValidationError = taggedError("ConfigValidationError")<{
  readonly fieldPath?: string;
}>;

export { ConfigParseError, ConfigReadError, ConfigValidationError };
