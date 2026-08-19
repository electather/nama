// oxlint-disable eslint/init-declarations, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, typescript/consistent-return -- Page-token verification keeps its ordered canonicalization, authentication, and zeroing steps explicit.
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
  readonly administratorId: string;
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
  readonly administrator_id: string;
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
  administrator_id: input.administratorId,
  cursor: input.cursor,
  expires_at: input.expiresAt,
  method: input.method,
  page_size: input.pageSize,
  query: input.query,
  version: PAGE_TOKEN_VERSION,
});

const validBindings = (input: PageTokenBindings): boolean =>
  input.administratorId.length > 0 &&
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

const dataProperties = (value: object): Readonly<Record<string, unknown>> | undefined => {
  const properties: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return;
    }
    properties[key] = descriptor.value;
  }
  return properties;
};

// fallow-ignore-next-line complexity -- Canonical token parsing rejects every malformed field and representation before returning a cursor.
const parsePayload = (canonicalJson: string): PageTokenPayload => {
  try {
    const value: unknown = JSON.parse(canonicalJson);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidToken();
    }
    const payload = dataProperties(value);
    if (payload === undefined) {
      throw invalidToken();
    }
    const expectedKeys = [
      "administrator_id",
      "cursor",
      "expires_at",
      "method",
      "page_size",
      "query",
      "version",
    ];
    const actualKeys = Object.keys(payload).toSorted();
    if (
      actualKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === expectedKeys[index]) ||
      payload["version"] !== PAGE_TOKEN_VERSION ||
      typeof payload["administrator_id"] !== "string" ||
      payload["administrator_id"].length === 0 ||
      typeof payload["cursor"] !== "string" ||
      payload["cursor"].length === 0 ||
      !Number.isSafeInteger(payload["expires_at"]) ||
      typeof payload["expires_at"] !== "number" ||
      typeof payload["method"] !== "string" ||
      payload["method"].length === 0 ||
      !Number.isSafeInteger(payload["page_size"]) ||
      typeof payload["page_size"] !== "number" ||
      payload["page_size"] <= 0 ||
      typeof payload["query"] !== "string"
    ) {
      throw invalidToken();
    }
    const typedPayload: PageTokenPayload = {
      administrator_id: payload["administrator_id"],
      cursor: payload["cursor"],
      expires_at: payload["expires_at"],
      method: payload["method"],
      page_size: payload["page_size"],
      query: payload["query"],
      version: PAGE_TOKEN_VERSION,
    };
    if (JSON.stringify(typedPayload) !== canonicalJson) {
      throw invalidToken();
    }
    return typedPayload;
  } catch (error) {
    if (error instanceof PageTokenInvalid) {
      throw error;
    }
    throw invalidToken();
  }
};

const makePageTokenCodec = async (encodedMasterKey: string): Promise<PageTokenCodec> => {
  const masterKey = Buffer.from(encodedMasterKey.slice(MASTER_KEY_PREFIX.length), "base64");
  if (
    !encodedMasterKey.startsWith(MASTER_KEY_PREFIX) ||
    masterKey.byteLength !== PAGE_TOKEN_KEY_BYTES
  ) {
    masterKey.fill(0);
    throw invalidToken();
  }
  let key: Buffer;
  try {
    key = Buffer.from(
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
          payload.administrator_id !== input.administratorId ||
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
