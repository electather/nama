// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers -- Cryptographic security vectors keep exact dimensions, key domains, and fail-closed variants together.
import { expect, it } from "vitest";

import {
  decryptPairingDelivery,
  derivePairingProtectionKeys,
  destroyPairingProtectionKeys,
  digestDeviceCredential,
  digestHumanCode,
  digestPollingToken,
  encryptPairingDelivery,
  fingerprintApproval,
} from "../pairing-protection-private.ts";

const ADMINISTRATOR_ID = "pairing-protection-administrator";
const APPROVAL_METHOD = "nama.api.v1.DeviceService.ApprovePairing";
const MASTER_KEY = `base64:${Buffer.alloc(32).toString("base64")}`;
const WRONG_MASTER_KEY = `base64:${Buffer.alloc(32, 1).toString("base64")}`;
const CREDENTIAL_SECRET = "pairing-credential-sentinel";

it("derives five separate keys and binds every encrypted delivery field", async () => {
  const keys = await derivePairingProtectionKeys(MASTER_KEY);
  const wrongKeys = await derivePairingProtectionKeys(WRONG_MASTER_KEY);
  try {
    const keyValues = [
      keys.humanCode,
      keys.pollingToken,
      keys.deviceVerifier,
      keys.deliveryEnvelope,
      keys.approvalFingerprint,
    ].map((value) => value.toString("hex"));
    expect(new Set(keyValues).size).toBe(5);

    const protectedValues = [
      digestHumanCode(keys.humanCode, CREDENTIAL_SECRET),
      digestPollingToken(keys.pollingToken, {
        pairingId: "pairing-id",
        secret: CREDENTIAL_SECRET,
        version: 1,
      }),
      digestDeviceCredential(keys.deviceVerifier, 1, CREDENTIAL_SECRET),
      fingerprintApproval(keys.approvalFingerprint, {
        administratorUserId: ADMINISTRATOR_ID,
        method: APPROVAL_METHOD,
        normalizedCode: CREDENTIAL_SECRET,
      }),
    ];
    try {
      expect(new Set(protectedValues.map((value) => value.toString("hex"))).size).toBe(4);
    } finally {
      for (const value of protectedValues) {
        value.fill(0);
      }
    }

    const context = {
      credentialVersion: 1,
      deviceId: "device-id",
      pairingId: "pairing-id",
    };
    const first = encryptPairingDelivery(keys.deliveryEnvelope, context, CREDENTIAL_SECRET);
    const second = encryptPairingDelivery(keys.deliveryEnvelope, context, CREDENTIAL_SECRET);
    expect(first.nonce).toHaveLength(12);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(decryptPairingDelivery(keys.deliveryEnvelope, { ...context, ...first })).toBe(
      CREDENTIAL_SECRET,
    );
    expect(() =>
      decryptPairingDelivery(keys.deliveryEnvelope, {
        ...context,
        ...first,
        pairingId: "moved-pairing",
      }),
    ).toThrow("Pairing credential delivery is unavailable");
    expect(() =>
      decryptPairingDelivery(wrongKeys.deliveryEnvelope, { ...context, ...first }),
    ).toThrow("Pairing credential delivery is unavailable");
    expect(() =>
      decryptPairingDelivery(keys.deliveryEnvelope, {
        ...context,
        ...first,
        envelopeVersion: 2,
      }),
    ).toThrow("Pairing credential delivery is unavailable");
    const damaged = Buffer.from(first.ciphertext);
    damaged[0] = (damaged[0] ?? 0) ^ 1;
    expect(() =>
      decryptPairingDelivery(keys.deliveryEnvelope, {
        ...context,
        ...first,
        ciphertext: damaged,
      }),
    ).toThrow("Pairing credential delivery is unavailable");
  } finally {
    destroyPairingProtectionKeys(keys);
    destroyPairingProtectionKeys(wrongKeys);
  }
});
