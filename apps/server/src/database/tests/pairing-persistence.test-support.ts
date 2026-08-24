import { Effect } from "effect";

import type { PairingPersistence } from "../pairing-persistence.ts";

const unexpectedPairingOperation = (description: string) => () => Effect.die(description);

const unusedPairingPersistence = Object.freeze({
  approvePairing: unexpectedPairingOperation("unexpected pairing approval"),
  beginPairing: unexpectedPairingOperation("unexpected pairing creation"),
  cleanupExpired: Effect.die("unexpected pairing cleanup"),
  cleanupHealthy: () => true,
  pollPairing: unexpectedPairingOperation("unexpected pairing poll"),
  recordDeviceSeen: unexpectedPairingOperation("unexpected Device activity"),
  revokeDevice: unexpectedPairingOperation("unexpected Device revocation"),
  verifyDeviceCredential: unexpectedPairingOperation("unexpected Device verification"),
}) satisfies PairingPersistence;

export { unusedPairingPersistence };
