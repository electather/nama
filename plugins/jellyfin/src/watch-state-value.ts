import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import {
  ProviderActivityReliability,
  ProviderActivitySemantics,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { isUnknownRecord } from "./value.ts";

const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const NANOSECONDS_PER_JELLYFIN_TICK = 100;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const UNIX_EPOCH_MILLISECONDS = 0;
const MONTH_NUMBER_OFFSET = 1;
const MINIMUM_PROTOBUF_TIMESTAMP_MILLISECONDS = Date.parse("0001-01-01T00:00:00.000Z");
const MAXIMUM_PROTOBUF_TIMESTAMP_MILLISECONDS = Date.parse("9999-12-31T23:59:59.999Z");
const PROVIDER_ACTIVITY_TIMESTAMP_PATTERN =
  /^(?<year>(?!0000)[0-9]{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;
const ZERO_TICKS = 0;
const INVALID_TICKS = Symbol("invalid_ticks");
const ABSENT_VALUE = Symbol("absent_value");

interface ProtobufTimestamp {
  readonly nanos: number;
  readonly seconds: bigint;
}
interface ProtobufDuration {
  readonly nanos: number;
  readonly seconds: bigint;
}
interface NormalizedProviderActivity {
  readonly occurredAt: ProtobufTimestamp;
  readonly reliability: ProviderActivityReliability;
  readonly semantics: ProviderActivitySemantics;
}
interface NormalizedWatchState {
  duration?: ProtobufDuration;
  readonly itemReference: ProviderItemReference;
  readonly observedAt: ProtobufTimestamp;
  position?: ProtobufDuration;
  providerActivity?: NormalizedProviderActivity;
  readonly watched: boolean;
}
interface JellyfinUserData {
  readonly played: boolean;
  readonly record: Readonly<Record<string, unknown>>;
}

const timestampFromMilliseconds = (milliseconds: number): ProtobufTimestamp => {
  const wholeSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  return {
    nanos: (milliseconds - wholeSeconds * MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND,
    seconds: BigInt(wholeSeconds),
  };
};

const parseOptionalTicks = (
  value: unknown,
): number | typeof ABSENT_VALUE | typeof INVALID_TICKS => {
  if (value === undefined || value === null) {
    return ABSENT_VALUE;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < ZERO_TICKS) {
    return INVALID_TICKS;
  }
  return value;
};

const durationFromTicks = (ticks: number): ProtobufDuration => ({
  nanos: (ticks % JELLYFIN_TICKS_PER_SECOND) * NANOSECONDS_PER_JELLYFIN_TICK,
  seconds: BigInt(Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND)),
});

const hasValidProviderActivityCalendarDate = (
  year: string,
  month: string,
  day: string,
): boolean => {
  const calendarYear = Number(year);
  const calendarMonth = Number(month);
  const calendarDay = Number(day);
  const calendarDate = new Date(UNIX_EPOCH_MILLISECONDS);
  calendarDate.setUTCFullYear(calendarYear, calendarMonth - MONTH_NUMBER_OFFSET, calendarDay);
  return (
    calendarDate.getUTCFullYear() === calendarYear &&
    calendarDate.getUTCMonth() + MONTH_NUMBER_OFFSET === calendarMonth &&
    calendarDate.getUTCDate() === calendarDay
  );
};
const hasValidProviderActivityTimestampFormat = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const groups = PROVIDER_ACTIVITY_TIMESTAMP_PATTERN.exec(value)?.groups;
  if (groups === undefined) {
    return false;
  }
  const { day, month, year } = groups;
  return (
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    hasValidProviderActivityCalendarDate(year, month, day)
  );
};

const providerActivityMilliseconds = (value: unknown): number | typeof ABSENT_VALUE => {
  if (!hasValidProviderActivityTimestampFormat(value)) {
    return ABSENT_VALUE;
  }
  const occurredAtMilliseconds = Date.parse(value);
  if (
    !Number.isFinite(occurredAtMilliseconds) ||
    occurredAtMilliseconds < MINIMUM_PROTOBUF_TIMESTAMP_MILLISECONDS ||
    occurredAtMilliseconds > MAXIMUM_PROTOBUF_TIMESTAMP_MILLISECONDS
  ) {
    return ABSENT_VALUE;
  }
  return occurredAtMilliseconds;
};

const providerActivity = (value: unknown): NormalizedProviderActivity | typeof ABSENT_VALUE => {
  const occurredAtMilliseconds = providerActivityMilliseconds(value);
  if (occurredAtMilliseconds === ABSENT_VALUE) {
    return ABSENT_VALUE;
  }
  return {
    occurredAt: timestampFromMilliseconds(occurredAtMilliseconds),
    reliability: ProviderActivityReliability.HEURISTIC,
    semantics: ProviderActivitySemantics.UNKNOWN,
  };
};

const watchStateUserData = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
): JellyfinUserData | typeof ABSENT_VALUE => {
  const userData = body["UserData"];
  if (
    body["Id"] !== itemReference.itemId ||
    (body["Type"] !== "Movie" && body["Type"] !== "Episode") ||
    !isUnknownRecord(userData) ||
    typeof userData["Played"] !== "boolean"
  ) {
    return ABSENT_VALUE;
  }
  return { played: userData["Played"], record: userData };
};

const applyProviderActivity = (state: NormalizedWatchState, userData: JellyfinUserData): void => {
  const activity = providerActivity(userData.record["LastPlayedDate"]);
  if (activity !== ABSENT_VALUE) {
    state.providerActivity = activity;
  }
};

const applyOptionalState = (
  state: NormalizedWatchState,
  body: Readonly<Record<string, unknown>>,
  userData: JellyfinUserData,
): boolean => {
  const positionTicks = parseOptionalTicks(userData.record["PlaybackPositionTicks"]);
  const durationTicks = parseOptionalTicks(body["RunTimeTicks"]);
  if (positionTicks === INVALID_TICKS || durationTicks === INVALID_TICKS) {
    return false;
  }
  if (durationTicks !== ABSENT_VALUE && durationTicks > ZERO_TICKS) {
    state.duration = durationFromTicks(durationTicks);
  }
  if (positionTicks !== ABSENT_VALUE && positionTicks > ZERO_TICKS) {
    state.position = durationFromTicks(positionTicks);
  }
  applyProviderActivity(state, userData);
  return true;
};

const normalizeJellyfinWatchState = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
  observedAt: ProtobufTimestamp,
): NormalizedWatchState | typeof ABSENT_VALUE => {
  const userData = watchStateUserData(itemReference, body);
  if (userData === ABSENT_VALUE) {
    return ABSENT_VALUE;
  }
  const state: NormalizedWatchState = {
    itemReference,
    observedAt,
    watched: userData.played,
  };
  if (!applyOptionalState(state, body, userData)) {
    return ABSENT_VALUE;
  }
  return state;
};

const normalizeJellyfinMutationWatchState = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
  observedAt: ProtobufTimestamp,
): NormalizedWatchState | typeof ABSENT_VALUE => {
  const returnedItemId = body["ItemId"];
  const watched = body["Played"];
  if (
    (returnedItemId !== undefined && returnedItemId !== itemReference.itemId) ||
    typeof watched !== "boolean"
  ) {
    return ABSENT_VALUE;
  }
  const state: NormalizedWatchState = { itemReference, observedAt, watched };
  const userData: JellyfinUserData = { played: watched, record: body };
  if (!applyOptionalState(state, body, userData)) {
    return ABSENT_VALUE;
  }
  return state;
};

export {
  ABSENT_VALUE,
  normalizeJellyfinMutationWatchState,
  normalizeJellyfinWatchState,
  timestampFromMilliseconds,
};
export type { NormalizedWatchState, ProtobufTimestamp };
