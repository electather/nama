import assert from "node:assert/strict";
import { it } from "node:test";

import { Code, ConnectError } from "@connectrpc/connect";

import { decodeCatalogContinuation, encodeCatalogContinuation } from "../catalog-continuation.ts";

const API_KEY = "credential-a";
const PROVIDER_INSTANCE_ID = "provider-instance";
const PROVIDER_REVISION = "revision-1";
const SCAN_ID = "scan-identity";
const CATALOG_CONTINUATION_VERSION = 1;
const CATALOG_CONTINUATION_LIFETIME_SECONDS = 86_400;
const MAXIMUM_CONTINUATION_LENGTH = 4096;
const HMAC_BYTES = 32;
const EMPTY_LENGTH = 0;
const FIRST_CODE_UNIT_LENGTH = 1;
const NOW = 1_800_000_000;
const EXPIRES_AT = NOW + CATALOG_CONTINUATION_LIFETIME_SECONDS;
const PAGE_SIZE = 50;
const OFFSET = 100;
const TOKEN = encodeCatalogContinuation({
  apiKey: API_KEY,
  expiresAt: EXPIRES_AT,
  offset: OFFSET,
  pageSize: PAGE_SIZE,
  providerInstanceId: PROVIDER_INSTANCE_ID,
  providerRevision: PROVIDER_REVISION,
  scanId: SCAN_ID,
});

const expectInvalidContinuation = (
  token: string,
  overrides: Partial<{
    apiKey: string;
    now: number;
    providerInstanceId: string;
    providerRevision: string;
    token: string;
  }> = {},
): void => {
  let failure: unknown = undefined;
  try {
    decodeCatalogContinuation({
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
};

void it("authenticates a versioned self-contained catalog continuation", () => {
  const token = TOKEN;
  assert.match(token, /^[A-Za-z0-9_-]+$/u);
  assert.ok(token.length <= MAXIMUM_CONTINUATION_LENGTH);

  const envelope = Buffer.from(token, "base64url");
  const payload: unknown = JSON.parse(
    envelope.subarray(EMPTY_LENGTH, -HMAC_BYTES).toString("utf8"),
  );
  assert.equal(typeof payload, "object");
  assert.ok(payload !== null);
  assert.ok(!Array.isArray(payload));
  assert.deepEqual(payload, {
    expires_at: EXPIRES_AT,
    offset: OFFSET,
    operation: "nama.plugin.v1.LibraryService.ListItems",
    page_size: PAGE_SIZE,
    provider_instance_id: PROVIDER_INSTANCE_ID,
    provider_revision: PROVIDER_REVISION,
    query_revision: "jellyfin-supported-catalog/v1",
    scan_id: SCAN_ID,
    version: CATALOG_CONTINUATION_VERSION,
  });
  assert.deepEqual(
    decodeCatalogContinuation({
      apiKey: API_KEY,
      now: NOW,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      providerRevision: PROVIDER_REVISION,
      token,
    }),
    {
      expiresAt: EXPIRES_AT,
      offset: OFFSET,
      pageSize: PAGE_SIZE,
      scanId: SCAN_ID,
    },
  );
});

void it("rejects tampered, expired, credential-changed, and mismatched continuations", () => {
  const token = TOKEN;
  let replacement = "A";
  if (token.startsWith(replacement)) {
    replacement = "B";
  }
  expectInvalidContinuation(`${replacement}${token.slice(FIRST_CODE_UNIT_LENGTH)}`);
  expectInvalidContinuation(token, { now: EXPIRES_AT });
  expectInvalidContinuation(token, { apiKey: "credential-b" });
  expectInvalidContinuation(token, { providerInstanceId: "different-instance" });
  expectInvalidContinuation(token, { providerRevision: "revision-2" });
});
