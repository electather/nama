// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-continue, eslint/no-magic-numbers -- The bounded byte parser is a single explicit state machine.
const MAXIMUM_RECORD_BYTES = 4096;
const RATE_LIMIT_BURST = 40;
const RATE_LIMIT_PER_MILLISECOND = 20 / 1000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ACCEPTED_LEVELS: Readonly<Record<string, true>> = Object.freeze({
  debug: true,
  error: true,
  info: true,
  warn: true,
});

interface PluginStderrNumberFieldDeclaration {
  readonly kind: "number";
}

interface PluginStderrEnumFieldDeclaration {
  readonly kind: "enum";
  readonly values: readonly string[];
}

type PluginStderrFieldDeclaration =
  | PluginStderrEnumFieldDeclaration
  | PluginStderrNumberFieldDeclaration;

interface PluginStderrEventDeclaration {
  readonly event: string;
  readonly fields: Readonly<Record<string, PluginStderrFieldDeclaration>>;
}

interface AcceptedPluginStderrRecord {
  readonly event: string;
  readonly fields: Readonly<Record<string, number | string>>;
  readonly level: "debug" | "error" | "info" | "warn";
}

interface PluginStderrSink {
  readonly accepted: (record: AcceptedPluginStderrRecord) => void;
  readonly dropped: () => void;
}

interface PluginStderrParser {
  readonly write: (chunk: Uint8Array) => void;
}
interface ParsedPluginStderrRecord {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level: AcceptedPluginStderrRecord["level"];
}

const isAcceptedLevel = (value: unknown): value is AcceptedPluginStderrRecord["level"] =>
  typeof value === "string" && ACCEPTED_LEVELS[value] === true;

// fallow-ignore-next-line code-duplication -- This local guard keeps the byte parser independent from the supervisor lifecycle module.
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactRecordKeys = (value: Readonly<Record<string, unknown>>): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === 3 && keys.includes("event") && keys.includes("fields") && keys.includes("level")
  );
};

const parsedRecord = (value: unknown): ParsedPluginStderrRecord | undefined => {
  if (!isUnknownRecord(value) || !hasExactRecordKeys(value)) {
    return undefined;
  }
  const { event, fields, level } = value;
  if (typeof event !== "string" || !isAcceptedLevel(level) || !isUnknownRecord(fields)) {
    return undefined;
  }
  return { event, fields, level };
};

const validatedFieldValue = (
  value: unknown,
  declaration: PluginStderrFieldDeclaration,
): number | string | undefined => {
  if (declaration.kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }
  if (typeof value === "string" && declaration.values.includes(value)) {
    return value;
  }
  return undefined;
};

const validatedFields = (
  values: Readonly<Record<string, unknown>>,
  declarations: ReadonlyMap<string, PluginStderrFieldDeclaration>,
): Readonly<Record<string, number | string>> | undefined => {
  const fields: Record<string, number | string> = {};
  for (const [name, value] of Object.entries(values)) {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return undefined;
    }
    const fieldValue = validatedFieldValue(value, declaration);
    if (fieldValue === undefined) {
      return undefined;
    }
    fields[name] = fieldValue;
  }
  return fields;
};

const validatedRecord = (
  value: unknown,
  declarations: ReadonlyMap<string, ReadonlyMap<string, PluginStderrFieldDeclaration>>,
): AcceptedPluginStderrRecord | undefined => {
  const parsed = parsedRecord(value);
  if (parsed === undefined) {
    return undefined;
  }
  const declaration = declarations.get(parsed.event);
  if (declaration === undefined) {
    return undefined;
  }
  const fields = validatedFields(parsed.fields, declaration);
  if (fields === undefined) {
    return undefined;
  }
  return { event: parsed.event, fields, level: parsed.level };
};

const makePluginStderrParser = (
  declarations: readonly PluginStderrEventDeclaration[],
  sink: PluginStderrSink,
  now: () => number = performance.now.bind(performance),
): PluginStderrParser => {
  const declarationByEvent = new Map(
    declarations.map(
      (declaration) => [declaration.event, new Map(Object.entries(declaration.fields))] as const,
    ),
  );
  const buffer = Buffer.allocUnsafe(MAXIMUM_RECORD_BYTES);
  let bufferLength = 0;
  let droppingOversizedRecord = false;
  let dropReported = false;
  let lastRefill = now();
  let tokens = RATE_LIMIT_BURST;

  const reportDrop = (): void => {
    if (!dropReported) {
      dropReported = true;
      sink.dropped();
    }
  };
  const acceptBufferedRecord = (): void => {
    if (droppingOversizedRecord || bufferLength === 0) {
      reportDrop();
      return;
    }
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(buffer.subarray(0, bufferLength)));
    } catch {
      reportDrop();
      return;
    }
    const record = validatedRecord(parsed, declarationByEvent);
    if (record === undefined) {
      reportDrop();
      return;
    }
    const currentTime = now();
    tokens = Math.min(
      RATE_LIMIT_BURST,
      tokens + (currentTime - lastRefill) * RATE_LIMIT_PER_MILLISECOND,
    );
    lastRefill = currentTime;
    if (tokens < 1) {
      reportDrop();
      return;
    }
    tokens -= 1;
    sink.accepted(record);
  };

  return {
    write: (chunk) => {
      for (const byte of chunk) {
        if (byte === 10) {
          acceptBufferedRecord();
          bufferLength = 0;
          droppingOversizedRecord = false;
          continue;
        }
        if (droppingOversizedRecord) {
          continue;
        }
        if (bufferLength === MAXIMUM_RECORD_BYTES) {
          droppingOversizedRecord = true;
          continue;
        }
        buffer[bufferLength] = byte;
        bufferLength += 1;
      }
    },
  };
};

export { makePluginStderrParser };
export type {
  AcceptedPluginStderrRecord,
  PluginStderrEventDeclaration,
  PluginStderrEnumFieldDeclaration,
  PluginStderrFieldDeclaration,
  PluginStderrNumberFieldDeclaration,
  PluginStderrParser,
  PluginStderrSink,
};
