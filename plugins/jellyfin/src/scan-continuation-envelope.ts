import { createHmac, timingSafeEqual } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type { ErrorInfo } from "@nama/api/google/rpc/error_details_pb.js";

const HMAC_ALGORITHM = "sha256";
const HMAC_BYTES = 32;
const MAXIMUM_TOKEN_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ZERO = 0;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const PAGE_TOKEN_INVALID_REASON = "PAGE_TOKEN_INVALID";

interface ScanContinuationScope {
  readonly invalidMessage: string;
  readonly keyDomain: string;
  readonly operation: string;
  readonly queryRevision: string;
}

const invalidScanContinuation = (scope: ScanContinuationScope): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason: PAGE_TOKEN_INVALID_REASON,
  };
  return new ConnectError(scope.invalidMessage, Code.InvalidArgument, undefined, [
    { desc: ErrorInfoSchema, value: errorInfo },
  ]);
};

const deriveSigningKey = (scope: ScanContinuationScope, apiKey: string): Buffer => {
  const credential = Buffer.from(apiKey, "utf8");
  try {
    return createHmac(HMAC_ALGORITHM, credential).update(scope.keyDomain, "utf8").digest();
  } finally {
    credential.fill(ZERO);
  }
};

const decodeEnvelope = (scope: ScanContinuationScope, token: string): Buffer => {
  if (token.length === ZERO || token.length > MAXIMUM_TOKEN_LENGTH || !BASE64URL.test(token)) {
    throw invalidScanContinuation(scope);
  }
  const envelope = Buffer.from(token, "base64url");
  if (envelope.toString("base64url") !== token || envelope.byteLength <= HMAC_BYTES) {
    envelope.fill(ZERO);
    throw invalidScanContinuation(scope);
  }
  return envelope;
};

const signScanContinuationPayload = (
  scope: ScanContinuationScope,
  apiKey: string,
  canonicalJson: string,
): string => {
  const payloadBytes = Buffer.from(canonicalJson, "utf8");
  const key = deriveSigningKey(scope, apiKey);
  const signature = createHmac(HMAC_ALGORITHM, key).update(payloadBytes).digest();
  const envelope = Buffer.concat([payloadBytes, signature]);
  try {
    const token = envelope.toString("base64url");
    if (token.length > MAXIMUM_TOKEN_LENGTH) {
      throw invalidScanContinuation(scope);
    }
    return token;
  } finally {
    key.fill(ZERO);
  }
};

const authenticateScanContinuationEnvelope = (
  scope: ScanContinuationScope,
  token: string,
  apiKey: string,
): string => {
  const envelope = decodeEnvelope(scope, token);
  const signatureOffset = envelope.byteLength - HMAC_BYTES;
  const payloadBytes = envelope.subarray(ZERO, signatureOffset);
  const key = deriveSigningKey(scope, apiKey);
  const expectedSignature = createHmac(HMAC_ALGORITHM, key).update(payloadBytes).digest();
  try {
    if (!timingSafeEqual(envelope.subarray(signatureOffset), expectedSignature)) {
      throw invalidScanContinuation(scope);
    }
    return payloadBytes.toString("utf8");
  } finally {
    key.fill(ZERO);
  }
};

export {
  authenticateScanContinuationEnvelope,
  invalidScanContinuation,
  signScanContinuationPayload,
};
export type { ScanContinuationScope };
