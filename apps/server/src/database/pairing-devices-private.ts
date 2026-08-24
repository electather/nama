import type { JsonObject, JsonValue } from "./database-types-private.ts";
import type { DeviceRecord } from "./pairing-persistence-model-private.ts";
import { device } from "./pairing-schema.ts";
// oxlint-disable-next-line unicorn/no-null -- JSON operation results encode absent Device timestamps as JSON null.
const JSON_NULL = null;
const ZERO = 0;

const deviceSelection = Object.freeze({
  createdAt: device.createdAt,
  displayName: device.displayName,
  id: device.id,
  lastSeenAt: device.lastSeenAt,
  revoked: device.revoked,
  revokedAt: device.revokedAt,
});

const serializeDevice = (record: DeviceRecord): JsonObject => ({
  createdAt: record.createdAt.toISOString(),
  displayName: record.displayName,
  id: record.id,
  lastSeenAt: record.lastSeenAt?.toISOString() ?? JSON_NULL,
  revoked: record.revoked,
  revokedAt: record.revokedAt?.toISOString() ?? JSON_NULL,
});

const ownValue = (value: JsonObject, key: string): JsonValue | undefined => {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }
  return value[key];
};

const parseTimestamp = (value: JsonValue | undefined): Date | null | undefined => {
  if (value === JSON_NULL) {
    return JSON_NULL;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return undefined;
  }
  return parsed;
};

const parseStoredDevice = (value: JsonObject): DeviceRecord | undefined => {
  const createdAt = parseTimestamp(ownValue(value, "createdAt"));
  const displayName = ownValue(value, "displayName");
  const id = ownValue(value, "id");
  const lastSeenAt = parseTimestamp(ownValue(value, "lastSeenAt"));
  const revoked = ownValue(value, "revoked");
  const revokedAt = parseTimestamp(ownValue(value, "revokedAt"));
  if (
    !(createdAt instanceof Date) ||
    typeof displayName !== "string" ||
    displayName.length === ZERO ||
    typeof id !== "string" ||
    id.length === ZERO ||
    lastSeenAt === undefined ||
    typeof revoked !== "boolean" ||
    revokedAt === undefined ||
    revoked !== (revokedAt !== JSON_NULL)
  ) {
    return undefined;
  }
  return { createdAt, displayName, id, lastSeenAt, revoked, revokedAt };
};

export { deviceSelection, parseStoredDevice, serializeDevice };
