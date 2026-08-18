import { isUnknownRecord } from "./value.ts";

const MAXIMUM_RECORD_BYTES = 4096;
const RATE_LIMIT_BURST = 40;
const RATE_LIMIT_PER_SECOND = 20;
const MILLISECONDS_PER_SECOND = 1000;
const RATE_LIMIT_PER_MILLISECOND = RATE_LIMIT_PER_SECOND / MILLISECONDS_PER_SECOND;
const EMPTY_BUFFER_LENGTH = 0;
const NEWLINE_BYTE = 10;
const ONE_TOKEN = 1;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ACCEPTED_LEVELS: ReadonlySet<string> = new Set(["debug", "error", "info", "warn"]);
const REQUIRED_RECORD_KEYS = ["event", "fields", "level"] as const;

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

interface BufferedRecordState {
  bufferLength: number;
  droppingOversizedRecord: boolean;
}

interface RecordAcceptorConfiguration {
  readonly buffer: Buffer;
  readonly declarations: ReadonlyMap<string, ReadonlyMap<string, PluginStderrFieldDeclaration>>;
  readonly now: () => number;
  readonly sink: PluginStderrSink;
  readonly state: BufferedRecordState;
}

const isAcceptedLevel = (value: unknown): value is AcceptedPluginStderrRecord["level"] =>
  typeof value === "string" && ACCEPTED_LEVELS.has(value);

const hasExactRecordKeys = (value: Readonly<Record<string, unknown>>): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === REQUIRED_RECORD_KEYS.length &&
    REQUIRED_RECORD_KEYS.every((requiredKey) => keys.includes(requiredKey))
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

const declarationIndex = (
  declarations: readonly PluginStderrEventDeclaration[],
): ReadonlyMap<string, ReadonlyMap<string, PluginStderrFieldDeclaration>> =>
  new Map(
    declarations.map(
      (declaration) => [declaration.event, new Map(Object.entries(declaration.fields))] as const,
    ),
  );

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

const decodedRecord = (
  buffer: Buffer,
  state: BufferedRecordState,
  declarations: ReadonlyMap<string, ReadonlyMap<string, PluginStderrFieldDeclaration>>,
): AcceptedPluginStderrRecord | undefined => {
  if (state.droppingOversizedRecord || state.bufferLength === EMPTY_BUFFER_LENGTH) {
    return undefined;
  }
  try {
    const text = UTF8_DECODER.decode(buffer.subarray(EMPTY_BUFFER_LENGTH, state.bufferLength));
    return validatedRecord(JSON.parse(text), declarations);
  } catch {
    return undefined;
  }
};

const rateLimiter = (now: () => number): ((currentTime: number) => boolean) => {
  let tokens = RATE_LIMIT_BURST;
  let lastRefill = now();
  return (currentTime) => {
    tokens = Math.min(
      RATE_LIMIT_BURST,
      tokens + (currentTime - lastRefill) * RATE_LIMIT_PER_MILLISECOND,
    );
    lastRefill = currentTime;
    if (tokens < ONE_TOKEN) {
      return false;
    }
    tokens -= ONE_TOKEN;
    return true;
  };
};

const resetBufferedRecord = (state: BufferedRecordState): void => {
  state.bufferLength = EMPTY_BUFFER_LENGTH;
  state.droppingOversizedRecord = false;
};

const writeNonNewlineByte = (buffer: Buffer, state: BufferedRecordState, byte: number): void => {
  if (state.droppingOversizedRecord) {
    return;
  }
  if (state.bufferLength === MAXIMUM_RECORD_BYTES) {
    state.droppingOversizedRecord = true;
    return;
  }
  buffer[state.bufferLength] = byte;
  state.bufferLength += ONE_TOKEN;
};

const makeRecordAcceptor = (configuration: RecordAcceptorConfiguration): (() => void) => {
  const { buffer, declarations, now, sink, state } = configuration;
  const allowRecord = rateLimiter(now);
  let dropReported = false;
  const reportDrop = (): void => {
    if (!dropReported) {
      dropReported = true;
      sink.dropped();
    }
  };
  return () => {
    const record = decodedRecord(buffer, state, declarations);
    if (record === undefined || !allowRecord(now())) {
      reportDrop();
      return;
    }
    sink.accepted(record);
  };
};

const makeByteWriter =
  (
    buffer: Buffer,
    state: BufferedRecordState,
    acceptBufferedRecord: () => void,
  ): ((byte: number) => void) =>
  (byte) => {
    if (byte === NEWLINE_BYTE) {
      acceptBufferedRecord();
      resetBufferedRecord(state);
      return;
    }
    writeNonNewlineByte(buffer, state, byte);
  };

const makePluginStderrParser = (
  declarations: readonly PluginStderrEventDeclaration[],
  sink: PluginStderrSink,
  now: () => number = performance.now.bind(performance),
): PluginStderrParser => {
  const indexedDeclarations = declarationIndex(declarations);
  const buffer = Buffer.allocUnsafe(MAXIMUM_RECORD_BYTES);
  const state: BufferedRecordState = {
    bufferLength: EMPTY_BUFFER_LENGTH,
    droppingOversizedRecord: false,
  };
  const acceptBufferedRecord = makeRecordAcceptor({
    buffer,
    declarations: indexedDeclarations,
    now,
    sink,
    state,
  });
  const writeByte = makeByteWriter(buffer, state, acceptBufferedRecord);
  return {
    write: (chunk) => {
      for (const byte of chunk) {
        writeByte(byte);
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
