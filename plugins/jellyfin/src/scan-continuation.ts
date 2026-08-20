import { Code, ConnectError } from "@connectrpc/connect";

import {
  authenticateScanContinuationEnvelope,
  invalidScanContinuation,
  signScanContinuationPayload,
} from "./scan-continuation-envelope.ts";
import type { ScanContinuationScope } from "./scan-continuation-envelope.ts";

const SCAN_CONTINUATION_VERSION = 1;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_PROVIDER_OFFSET = 2_147_483_647;
const MAXIMUM_SCAN_ID_LENGTH = 128;
const ZERO = 0;

interface ScanContinuationPosition {
  readonly expiresAt: number;
  readonly offset: number;
  readonly pageSize: number;
  readonly scanId: string;
}
interface ScanContinuationEncodeInput extends ScanContinuationPosition {
  readonly apiKey: string;
  readonly providerInstanceId: string;
  readonly providerRevision: string;
}
interface ScanContinuationDecodeInput {
  readonly apiKey: string;
  readonly now: number;
  readonly providerInstanceId: string;
  readonly providerRevision: string;
  readonly token: string;
}
interface ScanContinuationPayload {
  readonly expires_at: number;
  readonly offset: number;
  readonly operation: string;
  readonly page_size: number;
  readonly provider_instance_id: string;
  readonly provider_revision: string;
  readonly query_revision: string;
  readonly scan_id: string;
  readonly version: typeof SCAN_CONTINUATION_VERSION;
}

const PAYLOAD_KEYS = [
  "expires_at",
  "offset",
  "operation",
  "page_size",
  "provider_instance_id",
  "provider_revision",
  "query_revision",
  "scan_id",
  "version",
] as const;

const dataProperties = (value: object): Readonly<Record<string, unknown>> | undefined => {
  const properties: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    properties[key] = descriptor.value;
  }
  return properties;
};

const validNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > ZERO;

const validPosition = (position: ScanContinuationPosition): boolean =>
  Number.isSafeInteger(position.expiresAt) &&
  position.expiresAt > ZERO &&
  Number.isSafeInteger(position.offset) &&
  position.offset >= ZERO &&
  position.offset <= MAXIMUM_PROVIDER_OFFSET &&
  Number.isSafeInteger(position.pageSize) &&
  position.pageSize > ZERO &&
  position.pageSize <= MAXIMUM_PAGE_SIZE &&
  position.scanId.length > ZERO &&
  position.scanId.length <= MAXIMUM_SCAN_ID_LENGTH;

const payloadFor = (
  scope: ScanContinuationScope,
  input: ScanContinuationEncodeInput,
): ScanContinuationPayload => ({
  expires_at: input.expiresAt,
  offset: input.offset,
  operation: scope.operation,
  page_size: input.pageSize,
  provider_instance_id: input.providerInstanceId,
  provider_revision: input.providerRevision,
  query_revision: scope.queryRevision,
  scan_id: input.scanId,
  version: SCAN_CONTINUATION_VERSION,
});

const propertiesFromJson = (
  scope: ScanContinuationScope,
  canonicalJson: string,
): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(canonicalJson);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidScanContinuation(scope);
  }
  const properties = dataProperties(value);
  if (
    properties === undefined ||
    Reflect.ownKeys(properties).length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key) => Object.hasOwn(properties, key))
  ) {
    throw invalidScanContinuation(scope);
  }
  return properties;
};

const payloadFromProperties = (
  scope: ScanContinuationScope,
  properties: Readonly<Record<string, unknown>>,
): ScanContinuationPayload | undefined => {
  const {
    expires_at: expiresAt,
    offset,
    operation,
    page_size: pageSize,
    provider_instance_id: providerInstanceId,
    provider_revision: providerRevision,
    query_revision: queryRevision,
    scan_id: scanId,
    version,
  } = properties;
  if (
    typeof expiresAt !== "number" ||
    typeof offset !== "number" ||
    operation !== scope.operation ||
    typeof pageSize !== "number" ||
    !validNonemptyString(providerInstanceId) ||
    !validNonemptyString(providerRevision) ||
    queryRevision !== scope.queryRevision ||
    typeof scanId !== "string" ||
    version !== SCAN_CONTINUATION_VERSION ||
    !validPosition({ expiresAt, offset, pageSize, scanId })
  ) {
    return undefined;
  }
  return {
    expires_at: expiresAt,
    offset,
    operation,
    page_size: pageSize,
    provider_instance_id: providerInstanceId,
    provider_revision: providerRevision,
    query_revision: queryRevision,
    scan_id: scanId,
    version,
  };
};

const parsePayload = (
  scope: ScanContinuationScope,
  canonicalJson: string,
): ScanContinuationPayload => {
  try {
    const payload = payloadFromProperties(scope, propertiesFromJson(scope, canonicalJson));
    if (payload === undefined || JSON.stringify(payload) !== canonicalJson) {
      throw invalidScanContinuation(scope);
    }
    return payload;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.InvalidArgument) {
      throw error;
    }
    throw invalidScanContinuation(scope);
  }
};

const encodeScanContinuation = (
  scope: ScanContinuationScope,
  input: ScanContinuationEncodeInput,
): string => {
  if (
    input.apiKey.length === ZERO ||
    input.providerInstanceId.length === ZERO ||
    input.providerRevision.length === ZERO ||
    !validPosition(input)
  ) {
    throw invalidScanContinuation(scope);
  }
  return signScanContinuationPayload(scope, input.apiKey, JSON.stringify(payloadFor(scope, input)));
};

const decodeScanContinuation = (
  scope: ScanContinuationScope,
  input: ScanContinuationDecodeInput,
): ScanContinuationPosition => {
  if (
    input.apiKey.length === ZERO ||
    input.providerInstanceId.length === ZERO ||
    input.providerRevision.length === ZERO ||
    !Number.isSafeInteger(input.now)
  ) {
    throw invalidScanContinuation(scope);
  }
  const payload = parsePayload(
    scope,
    authenticateScanContinuationEnvelope(scope, input.token, input.apiKey),
  );
  if (
    payload.provider_instance_id !== input.providerInstanceId ||
    payload.provider_revision !== input.providerRevision ||
    payload.expires_at <= input.now
  ) {
    throw invalidScanContinuation(scope);
  }
  return {
    expiresAt: payload.expires_at,
    offset: payload.offset,
    pageSize: payload.page_size,
    scanId: payload.scan_id,
  };
};

export { decodeScanContinuation, encodeScanContinuation };
export type {
  ScanContinuationDecodeInput,
  ScanContinuationEncodeInput,
  ScanContinuationPosition,
  ScanContinuationScope,
};
