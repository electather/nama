// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers -- Page-token verification keeps its ordered canonicalization, authentication, and zeroing steps explicit.
import { createHmac, hkdf, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { Data } from "effect";

const PAGE_TOKEN_VERSION = 1;
const PAGE_TOKEN_KEY_BYTES = 32;
const PAGE_TOKEN_SIGNATURE_BYTES = 32;
const MASTER_KEY_PREFIX = "base64:";
const HKDF_HASH = "sha256";
const PAGE_TOKEN_KEY_INFO = Buffer.from("nama/page-tokens/v1", "utf8");
const EMPTY_HKDF_SALT = Buffer.alloc(0);
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const deriveHkdfOutput = promisify(hkdf);

const taggedError = Data.TaggedError;
const PageTokenInvalid = taggedError("PageTokenInvalid")<Record<string, never>>;
type PageTokenInvalidFailure = InstanceType<typeof PageTokenInvalid>;

interface PageTokenBindings {
  readonly principalId: string;
  readonly method: string;
  readonly pageSize: number;
  readonly query: string;
}

interface PageTokenEncodeInput extends PageTokenBindings {
  readonly cursor: string;
  readonly expiresAt: number;
}

interface PageTokenDecodeInput extends PageTokenBindings {
  readonly now: number;
  readonly token: string;
}

interface PageTokenPayload {
  readonly principal_id: string;
  readonly cursor: string;
  readonly expires_at: number;
  readonly method: string;
  readonly page_size: number;
  readonly query: string;
  readonly version: typeof PAGE_TOKEN_VERSION;
}

interface PageTokenCodec {
  readonly close: () => void;
  readonly decode: (input: PageTokenDecodeInput) => string;
  readonly encode: (input: PageTokenEncodeInput) => string;
}

const invalidToken = (): PageTokenInvalidFailure => new PageTokenInvalid({});

const payloadFor = (input: PageTokenEncodeInput): PageTokenPayload => ({
  cursor: input.cursor,
  expires_at: input.expiresAt,
  method: input.method,
  page_size: input.pageSize,
  principal_id: input.principalId,
  query: input.query,
  version: PAGE_TOKEN_VERSION,
});

const validBindings = (input: PageTokenBindings): boolean =>
  input.principalId.length > 0 &&
  input.method.length > 0 &&
  Number.isSafeInteger(input.pageSize) &&
  input.pageSize > 0;

const sign = (key: Buffer, payload: string): Buffer =>
  createHmac(HKDF_HASH, key).update(payload, "utf8").digest();

const decodeBase64url = (segment: string): Buffer => {
  if (!BASE64URL_SEGMENT.test(segment)) {
    throw invalidToken();
  }
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) {
    decoded.fill(0);
    throw invalidToken();
  }
  return decoded;
};

const PAYLOAD_KEYS = [
  "principal_id",
  "cursor",
  "expires_at",
  "method",
  "page_size",
  "query",
  "version",
];

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

const hasExactPayloadKeys = (properties: Readonly<Record<string, unknown>>): boolean =>
  Reflect.ownKeys(properties).length === PAYLOAD_KEYS.length &&
  PAYLOAD_KEYS.every((key) => Object.hasOwn(properties, key));

const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const payloadFromProperties = (
  properties: Readonly<Record<string, unknown>>,
): PageTokenPayload | undefined => {
  const {
    principal_id: principalId,
    cursor,
    expires_at: expiresAt,
    method,
    page_size: pageSize,
    query,
    version,
  } = properties;
  if (
    version !== PAGE_TOKEN_VERSION ||
    !nonemptyString(principalId) ||
    !nonemptyString(cursor) ||
    !positiveSafeInteger(expiresAt) ||
    !nonemptyString(method) ||
    !positiveSafeInteger(pageSize) ||
    typeof query !== "string"
  ) {
    return undefined;
  }
  return {
    cursor,
    expires_at: expiresAt,
    method,
    page_size: pageSize,
    principal_id: principalId,
    query,
    version: PAGE_TOKEN_VERSION,
  };
};

const propertiesFromJson = (canonicalJson: string): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(canonicalJson);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidToken();
  }
  const properties = dataProperties(value);
  if (properties === undefined || !hasExactPayloadKeys(properties)) {
    throw invalidToken();
  }
  return properties;
};

const parsePayload = (canonicalJson: string): PageTokenPayload => {
  try {
    const payload = payloadFromProperties(propertiesFromJson(canonicalJson));
    if (payload === undefined || JSON.stringify(payload) !== canonicalJson) {
      throw invalidToken();
    }
    return payload;
  } catch (error) {
    if (error instanceof PageTokenInvalid) {
      throw error;
    }
    throw invalidToken();
  }
};

const derivePageTokenKey = async (encodedMasterKey: string): Promise<Buffer> => {
  const masterKey = Buffer.from(encodedMasterKey.slice(MASTER_KEY_PREFIX.length), "base64");
  if (
    !encodedMasterKey.startsWith(MASTER_KEY_PREFIX) ||
    masterKey.byteLength !== PAGE_TOKEN_KEY_BYTES
  ) {
    masterKey.fill(0);
    throw invalidToken();
  }
  try {
    return Buffer.from(
      await deriveHkdfOutput(
        HKDF_HASH,
        masterKey,
        EMPTY_HKDF_SALT,
        PAGE_TOKEN_KEY_INFO,
        PAGE_TOKEN_KEY_BYTES,
      ),
    );
  } finally {
    masterKey.fill(0);
  }
};

const makePageTokenCodec = async (encodedMasterKey: string): Promise<PageTokenCodec> => {
  const key = await derivePageTokenKey(encodedMasterKey);
  let closed = false;
  const requireOpen = (): void => {
    if (closed) {
      throw invalidToken();
    }
  };
  return Object.freeze({
    close: () => {
      if (!closed) {
        closed = true;
        key.fill(0);
      }
    },
    // fallow-ignore-next-line complexity -- Verification keeps signature, binding, expiry, and zeroing checks in one fail-closed sequence.
    decode: (input: PageTokenDecodeInput): string => {
      requireOpen();
      if (!validBindings(input) || !Number.isSafeInteger(input.now)) {
        throw invalidToken();
      }
      const envelope = decodeBase64url(input.token);
      try {
        if (envelope.byteLength <= PAGE_TOKEN_SIGNATURE_BYTES) {
          throw invalidToken();
        }
        const signatureOffset = envelope.byteLength - PAGE_TOKEN_SIGNATURE_BYTES;
        const payloadBytes = envelope.subarray(0, signatureOffset);
        const signature = envelope.subarray(signatureOffset);
        const canonicalJson = payloadBytes.toString("utf8");
        const expectedSignature = sign(key, canonicalJson);
        try {
          if (!timingSafeEqual(signature, expectedSignature)) {
            throw invalidToken();
          }
        } finally {
          expectedSignature.fill(0);
        }
        const payload = parsePayload(canonicalJson);
        if (
          payload.principal_id !== input.principalId ||
          payload.method !== input.method ||
          payload.page_size !== input.pageSize ||
          payload.query !== input.query ||
          payload.expires_at <= input.now
        ) {
          throw invalidToken();
        }
        return payload.cursor;
      } finally {
        envelope.fill(0);
      }
    },
    encode: (input: PageTokenEncodeInput): string => {
      requireOpen();
      if (
        !validBindings(input) ||
        input.cursor.length === 0 ||
        !Number.isSafeInteger(input.expiresAt)
      ) {
        throw invalidToken();
      }
      const canonicalJson = JSON.stringify(payloadFor(input));
      const payloadBytes = Buffer.from(canonicalJson, "utf8");
      const signature = sign(key, canonicalJson);
      const envelope = Buffer.concat([payloadBytes, signature]);
      try {
        return envelope.toString("base64url");
      } finally {
        envelope.fill(0);
        payloadBytes.fill(0);
        signature.fill(0);
      }
    },
  });
};

export { PageTokenInvalid, makePageTokenCodec };
export type {
  PageTokenBindings,
  PageTokenCodec,
  PageTokenDecodeInput,
  PageTokenEncodeInput,
  PageTokenInvalidFailure,
};
