// oxlint-disable eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Token attack cases keep each rejected binding visible.
import { expect, it } from "@effect/vitest";

import { makePageTokenCodec } from "../page-token.ts";

const METHOD = "nama.api.v1.ProviderService.ListProviderTypes";
const MASTER_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
const OTHER_MASTER_KEY = `base64:${Buffer.alloc(32, 8).toString("base64")}`;
const bindings = Object.freeze({
  administratorId: "administrator-a",
  cursor: "jellyfin",
  expiresAt: 900_000,
  method: METHOD,
  pageSize: 1,
  query: "{}",
});

it("encodes canonical authenticated provider page tokens as unpadded base64url", async () => {
  const codec = await makePageTokenCodec(MASTER_KEY);
  try {
    const token = codec.encode(bindings);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain("=");
    const envelope = Buffer.from(token, "base64url");
    expect(envelope.byteLength).toBeGreaterThan(32);
    const payload = envelope.subarray(0, -32);
    expect(payload.toString("utf8")).toBe(
      '{"administrator_id":"administrator-a","cursor":"jellyfin","expires_at":900000,"method":"nama.api.v1.ProviderService.ListProviderTypes","page_size":1,"query":"{}","version":1}',
    );
    expect(
      codec.decode({
        administratorId: bindings.administratorId,
        method: bindings.method,
        now: 899_999,
        pageSize: bindings.pageSize,
        query: bindings.query,
        token,
      }),
    ).toBe("jellyfin");
  } finally {
    codec.close();
  }
});

it("rejects tampering, expiry, key changes, and cross-query token reuse", async () => {
  const codec = await makePageTokenCodec(MASTER_KEY);
  const otherCodec = await makePageTokenCodec(OTHER_MASTER_KEY);
  try {
    const token = codec.encode(bindings);
    const decode = (overrides: Readonly<Record<string, unknown>> = {}) =>
      codec.decode({
        administratorId: bindings.administratorId,
        method: bindings.method,
        now: 899_999,
        pageSize: bindings.pageSize,
        query: bindings.query,
        token,
        ...overrides,
      });

    expect(() => decode({ administratorId: "administrator-b" })).toThrow();
    expect(() => decode({ method: "nama.api.v1.ProviderService.ListProviderInstances" })).toThrow();
    expect(() => decode({ query: '{"filter":"changed"}' })).toThrow();
    expect(() => decode({ pageSize: 2 })).toThrow();
    expect(() => decode({ now: bindings.expiresAt })).toThrow();
    const lastCharacter = token.at(-1);
    expect(lastCharacter).toBeDefined();
    const tampered = `${token.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
    expect(() => decode({ token: tampered })).toThrow();
    expect(() =>
      otherCodec.decode({
        administratorId: bindings.administratorId,
        method: bindings.method,
        now: 899_999,
        pageSize: bindings.pageSize,
        query: bindings.query,
        token,
      }),
    ).toThrow();
  } finally {
    codec.close();
    otherCodec.close();
  }
});
