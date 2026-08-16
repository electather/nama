import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeBetterAuthAdapter } from "../better-auth-adapter.ts";
import {
  DIFFERENT_MASTER_KEY,
  HKDF_OUTPUT_BYTES,
  MASTER_KEY,
  UNPADDED_BASE64URL,
  UNPADDED_SECRET_LENGTH,
  capturedSecret,
  expectedSecret,
  makeInput,
  makeRuntimeFakes,
} from "./better-auth-adapter-construction.test-support.ts";

const constructSecret = (masterKey: Buffer) =>
  Effect.gen(function* constructedSecretTest() {
    const fakes = makeRuntimeFakes();
    yield* makeBetterAuthAdapter(makeInput(fakes.loadModule, masterKey));
    return capturedSecret(fakes);
  });

it.effect(
  "derives the deterministic unpadded Better Auth secret with the specified HKDF context",
  () =>
    Effect.gen(function* hkdfDerivationTest() {
      const expected = yield* Effect.promise(() => expectedSecret(MASTER_KEY));
      const firstSecret = yield* constructSecret(MASTER_KEY);
      const secondSecret = yield* constructSecret(MASTER_KEY);

      expect(firstSecret).toBe(expected);
      expect(secondSecret).toBe(expected);
      expect(firstSecret).toBe(secondSecret);
      expect(firstSecret).toHaveLength(UNPADDED_SECRET_LENGTH);
      expect(firstSecret).toMatch(UNPADDED_BASE64URL);
      expect(Buffer.from(firstSecret, "base64url")).toHaveLength(HKDF_OUTPUT_BYTES);
    }),
);

it.effect("derives different Better Auth secrets from different master keys", () =>
  Effect.gen(function* differentMasterKeysTest() {
    const [firstExpected, secondExpected] = yield* Effect.promise(() =>
      Promise.all([expectedSecret(MASTER_KEY), expectedSecret(DIFFERENT_MASTER_KEY)]),
    );
    const firstSecret = yield* constructSecret(MASTER_KEY);
    const secondSecret = yield* constructSecret(DIFFERENT_MASTER_KEY);

    expect(firstSecret).toBe(firstExpected);
    expect(secondSecret).toBe(secondExpected);
    expect(firstSecret).not.toBe(secondSecret);
  }),
);
