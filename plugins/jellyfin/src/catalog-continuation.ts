import { createHmac, timingSafeEqual } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";

const CATALOG_CONTINUATION_VERSION = 1;
const CATALOG_CONTINUATION_OPERATION = "nama.plugin.v1.LibraryService.ListItems";
const CATALOG_QUERY_REVISION = "jellyfin-supported-catalog/v1";
const CATALOG_CONTINUATION_KEY_DOMAIN = "nama/plugin/jellyfin/catalog-continuations/v1";
const HMAC_ALGORITHM = "sha256";
const HMAC_BYTES = 32;
const MAXIMUM_TOKEN_LENGTH = 4096;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_PROVIDER_OFFSET = 2_147_483_647;
const MAXIMUM_SCAN_ID_LENGTH = 128;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ZERO = 0;

interface CatalogContinuationBindings {
  readonly apiKey: string;
  readonly providerInstanceId: string;
  readonly providerRevision: string;
}

interface CatalogContinuationPosition {
  readonly expiresAt: number;
  readonly offset: number;
  readonly pageSize: number;
  readonly scanId: string;
}

interface CatalogContinuationEncodeInput
  extends CatalogContinuationBindings, CatalogContinuationPosition {}

interface CatalogContinuationDecodeInput extends CatalogContinuationBindings {
  readonly now: number;
  readonly token: string;
}

interface CatalogContinuationPayload {
  readonly expires_at: number;
  readonly offset: number;
  readonly operation: typeof CATALOG_CONTINUATION_OPERATION;
  readonly page_size: number;
  readonly provider_instance_id: string;
  readonly provider_revision: string;
  readonly query_revision: typeof CATALOG_QUERY_REVISION;
  readonly scan_id: string;
  readonly version: typeof CATALOG_CONTINUATION_VERSION;
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

const validPosition = (position: CatalogContinuationPosition): boolean =>
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

const payloadFor = (input: CatalogContinuationEncodeInput): CatalogContinuationPayload => ({
  expires_at: input.expiresAt,
  offset: input.offset,
  operation: CATALOG_CONTINUATION_OPERATION,
  page_size: input.pageSize,
  provider_instance_id: input.providerInstanceId,
  provider_revision: input.providerRevision,
  query_revision: CATALOG_QUERY_REVISION,
  scan_id: input.scanId,
  version: CATALOG_CONTINUATION_VERSION,
});

const propertiesFromJson = (canonicalJson: string): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(canonicalJson);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  const properties = dataProperties(value);
  if (
    properties === undefined ||
    Reflect.ownKeys(properties).length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key) => Object.hasOwn(properties, key))
  ) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  return properties;
};

const payloadFromProperties = (
  properties: Readonly<Record<string, unknown>>,
): CatalogContinuationPayload | undefined => {
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
    operation !== CATALOG_CONTINUATION_OPERATION ||
    typeof pageSize !== "number" ||
    !validNonemptyString(providerInstanceId) ||
    !validNonemptyString(providerRevision) ||
    queryRevision !== CATALOG_QUERY_REVISION ||
    typeof scanId !== "string" ||
    version !== CATALOG_CONTINUATION_VERSION ||
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

const parsePayload = (canonicalJson: string): CatalogContinuationPayload => {
  try {
    const payload = payloadFromProperties(propertiesFromJson(canonicalJson));
    if (payload === undefined || JSON.stringify(payload) !== canonicalJson) {
      throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
    }
    return payload;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.InvalidArgument) {
      throw error;
    }
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
};

const deriveSigningKey = (apiKey: string): Buffer => {
  const credential = Buffer.from(apiKey, "utf8");
  try {
    return createHmac(HMAC_ALGORITHM, credential)
      .update(CATALOG_CONTINUATION_KEY_DOMAIN, "utf8")
      .digest();
  } finally {
    credential.fill(ZERO);
  }
};

const decodeEnvelope = (token: string): Buffer => {
  if (token.length === ZERO || token.length > MAXIMUM_TOKEN_LENGTH || !BASE64URL.test(token)) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  const envelope = Buffer.from(token, "base64url");
  if (envelope.toString("base64url") !== token || envelope.byteLength <= HMAC_BYTES) {
    envelope.fill(ZERO);
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  return envelope;
};

const tokenFromPayload = (input: CatalogContinuationEncodeInput): string => {
  const payloadBytes = Buffer.from(JSON.stringify(payloadFor(input)), "utf8");
  const key = deriveSigningKey(input.apiKey);
  const signature = createHmac(HMAC_ALGORITHM, key).update(payloadBytes).digest();
  const envelope = Buffer.concat([payloadBytes, signature]);
  try {
    const token = envelope.toString("base64url");
    if (token.length > MAXIMUM_TOKEN_LENGTH) {
      throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
    }
    return token;
  } finally {
    key.fill(ZERO);
  }
};

const encodeCatalogContinuation = (input: CatalogContinuationEncodeInput): string => {
  if (
    input.apiKey.length === ZERO ||
    input.providerInstanceId.length === ZERO ||
    input.providerRevision.length === ZERO ||
    !validPosition(input)
  ) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  return tokenFromPayload(input);
};

const authenticatedPayloadJson = (token: string, apiKey: string): string => {
  const envelope = decodeEnvelope(token);
  const signatureOffset = envelope.byteLength - HMAC_BYTES;
  const payloadBytes = envelope.subarray(ZERO, signatureOffset);
  const key = deriveSigningKey(apiKey);
  const expectedSignature = createHmac(HMAC_ALGORITHM, key).update(payloadBytes).digest();
  try {
    if (!timingSafeEqual(envelope.subarray(signatureOffset), expectedSignature)) {
      throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
    }
    return payloadBytes.toString("utf8");
  } finally {
    key.fill(ZERO);
  }
};

const decodeCatalogContinuation = (
  input: CatalogContinuationDecodeInput,
): CatalogContinuationPosition => {
  if (
    input.apiKey.length === ZERO ||
    input.providerInstanceId.length === ZERO ||
    input.providerRevision.length === ZERO ||
    !Number.isSafeInteger(input.now)
  ) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  const payload = parsePayload(authenticatedPayloadJson(input.token, input.apiKey));
  if (
    payload.provider_instance_id !== input.providerInstanceId ||
    payload.provider_revision !== input.providerRevision ||
    payload.expires_at <= input.now
  ) {
    throw new ConnectError("catalog continuation is invalid", Code.InvalidArgument);
  }
  return {
    expiresAt: payload.expires_at,
    offset: payload.offset,
    pageSize: payload.page_size,
    scanId: payload.scan_id,
  };
};

export { decodeCatalogContinuation, encodeCatalogContinuation };
export type { CatalogContinuationPosition };
