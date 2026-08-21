import assert from "node:assert/strict";
import { it } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";

import { decodeCatalogContinuation } from "../catalog-continuation.ts";
import {
  decodeWatchStateContinuation,
  encodeWatchStateContinuation,
} from "../watch-state-continuation.ts";

const API_KEY = "credential-a";
const PROVIDER_INSTANCE_ID = "provider-instance";
const PROVIDER_REVISION = "revision-1";
const SCAN_ID = "watch-scan-identity";
const NOW = 1_800_000_000;
const CONTINUATION_LIFETIME_SECONDS = 86_400;
const EXPIRES_AT = NOW + CONTINUATION_LIFETIME_SECONDS;
const PAGE_SIZE = 50;
const OFFSET = 100;
const HMAC_BYTES = 32;
const EMPTY_LENGTH = 0;
const WATCH_STATE_CONTINUATION_VERSION = 1;
const PAGE_TOKEN_INVALID_REASON = "PAGE_TOKEN_INVALID";
const TOKEN = encodeWatchStateContinuation({
  apiKey: API_KEY,
  expiresAt: EXPIRES_AT,
  offset: OFFSET,
  pageSize: PAGE_SIZE,
  providerInstanceId: PROVIDER_INSTANCE_ID,
  providerRevision: PROVIDER_REVISION,
  scanId: SCAN_ID,
});

type DecodeWatchStateContinuation = typeof decodeWatchStateContinuation;
type DecodeInput = Parameters<DecodeWatchStateContinuation>[number];

const expectInvalidContinuation = (
  decode: DecodeWatchStateContinuation,
  token: string,
  overrides: Partial<DecodeInput> = {},
): void => {
  let failure: unknown = undefined;
  try {
    decode({
      apiKey: API_KEY,
      now: NOW,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      providerRevision: PROVIDER_REVISION,
      token,
      ...overrides,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ConnectError);
  assert.equal(failure.code, Code.InvalidArgument);
  const [errorInfo] = failure.findDetails(ErrorInfoSchema);
  assert.equal(errorInfo?.reason, PAGE_TOKEN_INVALID_REASON);
};

void it("authenticates a distinct versioned watch-state continuation", () => {
  const envelope = Buffer.from(TOKEN, "base64url");
  const payload: unknown = JSON.parse(
    envelope.subarray(EMPTY_LENGTH, -HMAC_BYTES).toString("utf8"),
  );
  assert.deepEqual(payload, {
    expires_at: EXPIRES_AT,
    offset: OFFSET,
    operation: "nama.plugin.v1.WatchStateService.ListWatchStates",
    page_size: PAGE_SIZE,
    provider_instance_id: PROVIDER_INSTANCE_ID,
    provider_revision: PROVIDER_REVISION,
    query_revision: "jellyfin-supported-watch-state/v1",
    scan_id: SCAN_ID,
    version: WATCH_STATE_CONTINUATION_VERSION,
  });
  assert.deepEqual(
    decodeWatchStateContinuation({
      apiKey: API_KEY,
      now: NOW,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      providerRevision: PROVIDER_REVISION,
      token: TOKEN,
    }),
    {
      expiresAt: EXPIRES_AT,
      offset: OFFSET,
      pageSize: PAGE_SIZE,
      scanId: SCAN_ID,
    },
  );
});

void it("rejects expired, credential-changed, mismatched, and cross-scope tokens", () => {
  expectInvalidContinuation(decodeWatchStateContinuation, TOKEN, { now: EXPIRES_AT });
  expectInvalidContinuation(decodeWatchStateContinuation, TOKEN, { apiKey: "credential-b" });
  expectInvalidContinuation(decodeWatchStateContinuation, TOKEN, {
    providerInstanceId: "different-instance",
  });
  expectInvalidContinuation(decodeWatchStateContinuation, TOKEN, {
    providerRevision: "revision-2",
  });
  expectInvalidContinuation(decodeCatalogContinuation, TOKEN);
});
