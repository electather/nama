import { Option, Schema } from "effect";

type Environment = Readonly<Record<string, string | undefined>>;
type FieldOverride = readonly [field: string, value: string | undefined];

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

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

export { applyContentOverrides };
export type { Environment };
