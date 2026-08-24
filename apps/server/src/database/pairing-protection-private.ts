import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdf,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const ZERO = 0;
const AUTHENTICATION_TAG_BYTES = 16;
const DELIVERY_ENVELOPE_VERSION = 1;
const DIGEST_VERSION = 1;
const EMPTY_HKDF_SALT = Buffer.alloc(ZERO);
const HKDF_HASH = "sha256";
const KEY_BYTES = 32;
const LENGTH_PREFIX_BYTES = 4;
const NONCE_BYTES = 12;
const HUMAN_CODE_INFO = Buffer.from("nama/pairing-human-codes/v1", "utf8");
const POLLING_TOKEN_INFO = Buffer.from("nama/pairing-polling-tokens/v1", "utf8");
const DEVICE_VERIFIER_INFO = Buffer.from("nama/device-credential-verifiers/v1", "utf8");
const DELIVERY_ENVELOPE_INFO = Buffer.from("nama/pairing-delivery-envelopes/v1", "utf8");
const APPROVAL_FINGERPRINT_INFO = Buffer.from("nama/pairing-approval-fingerprints/v1", "utf8");
const deriveHkdfOutput = promisify(hkdf);

interface PairingProtectionKeys {
  readonly approvalFingerprint: Buffer;
  readonly deliveryEnvelope: Buffer;
  readonly deviceVerifier: Buffer;
  readonly humanCode: Buffer;
  readonly pollingToken: Buffer;
}

interface DeliveryContext {
  readonly credentialVersion: number;
  readonly deviceId: string;
  readonly pairingId: string;
}

interface DeliveryEnvelope {
  readonly authenticationTag: Buffer;
  readonly ciphertext: Buffer;
  readonly envelopeVersion: number;
  readonly nonce: Buffer;
}

interface StoredDeliveryEnvelope extends DeliveryContext, DeliveryEnvelope {}

interface ApprovalFingerprintInput {
  readonly administratorUserId: string;
  readonly method: string;
  readonly normalizedCode: string;
}

interface PollingTokenDigestInput {
  readonly pairingId: string;
  readonly secret: string;
  readonly version: number;
}

class UnreadablePairingDeliveryError extends Error {
  override readonly name = "UnreadablePairingDeliveryError";
}

const pairingDeliveryUnavailableSignal = new UnreadablePairingDeliveryError(
  "Pairing credential delivery is unavailable",
);

// fallow-ignore-next-line code-duplication -- Pairing protection stays domain-owned rather than sharing the provider encryption boundary.
const frame = (fields: readonly Uint8Array[]): Buffer => {
  const size = fields.reduce(
    (total, field) => total + LENGTH_PREFIX_BYTES + field.byteLength,
    ZERO,
  );
  const framed = Buffer.alloc(size);
  let offset = ZERO;
  for (const field of fields) {
    framed.writeUInt32BE(field.byteLength, offset);
    offset += LENGTH_PREFIX_BYTES;
    framed.set(field, offset);
    offset += field.byteLength;
  }
  return framed;
};

const versionBytes = (version: number): Buffer => {
  const value = Buffer.alloc(LENGTH_PREFIX_BYTES);
  value.writeUInt32BE(version);
  return value;
};

const deriveKey = async (masterKey: Buffer, info: Buffer): Promise<Buffer> =>
  Buffer.from(await deriveHkdfOutput(HKDF_HASH, masterKey, EMPTY_HKDF_SALT, info, KEY_BYTES));

const derivePairingProtectionKeys = async (
  encodedMasterKey: string,
): Promise<PairingProtectionKeys> => {
  const masterKey = Buffer.from(encodedMasterKey.slice("base64:".length), "base64");
  try {
    const [humanCode, pollingToken, deviceVerifier, deliveryEnvelope, approvalFingerprint] =
      await Promise.all([
        deriveKey(masterKey, HUMAN_CODE_INFO),
        deriveKey(masterKey, POLLING_TOKEN_INFO),
        deriveKey(masterKey, DEVICE_VERIFIER_INFO),
        deriveKey(masterKey, DELIVERY_ENVELOPE_INFO),
        deriveKey(masterKey, APPROVAL_FINGERPRINT_INFO),
      ]);
    return { approvalFingerprint, deliveryEnvelope, deviceVerifier, humanCode, pollingToken };
  } finally {
    masterKey.fill(ZERO);
  }
};

const destroyPairingProtectionKeys = (keys: PairingProtectionKeys): void => {
  keys.approvalFingerprint.fill(ZERO);
  keys.deliveryEnvelope.fill(ZERO);
  keys.deviceVerifier.fill(ZERO);
  keys.humanCode.fill(ZERO);
  keys.pollingToken.fill(ZERO);
};

const keyedDigest = (key: Buffer, fields: readonly Uint8Array[]): Buffer => {
  const input = frame(fields);
  try {
    return createHmac(HKDF_HASH, key).update(input).digest();
  } finally {
    input.fill(ZERO);
  }
};

const digestHumanCode = (key: Buffer, normalizedCode: string): Buffer =>
  keyedDigest(key, [versionBytes(DIGEST_VERSION), Buffer.from(normalizedCode, "utf8")]);

const digestPollingToken = (key: Buffer, input: PollingTokenDigestInput): Buffer =>
  keyedDigest(key, [
    versionBytes(input.version),
    Buffer.from(input.pairingId, "utf8"),
    Buffer.from(input.secret, "utf8"),
  ]);

const digestDeviceCredential = (key: Buffer, version: number, secret: string): Buffer =>
  keyedDigest(key, [versionBytes(version), Buffer.from(secret, "utf8")]);

const fingerprintApproval = (key: Buffer, input: ApprovalFingerprintInput): Buffer =>
  keyedDigest(key, [
    versionBytes(DIGEST_VERSION),
    Buffer.from(input.administratorUserId, "utf8"),
    Buffer.from(input.method, "utf8"),
    Buffer.from(input.normalizedCode, "utf8"),
  ]);

const deliveryAssociatedData = (context: DeliveryContext): Buffer =>
  frame([
    versionBytes(DELIVERY_ENVELOPE_VERSION),
    Buffer.from(context.pairingId, "utf8"),
    Buffer.from(context.deviceId, "utf8"),
    versionBytes(context.credentialVersion),
  ]);

// fallow-ignore-next-line code-duplication -- Pairing protection stays domain-owned rather than sharing the provider encryption boundary.
const encryptPairingDelivery = (
  key: Buffer,
  context: DeliveryContext,
  credentialSecret: string,
): DeliveryEnvelope => {
  const nonce = randomBytes(NONCE_BYTES);
  const associatedData = deliveryAssociatedData(context);
  const plaintext = Buffer.from(credentialSecret, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      authenticationTag: cipher.getAuthTag(),
      ciphertext,
      envelopeVersion: DELIVERY_ENVELOPE_VERSION,
      nonce,
    };
  } finally {
    associatedData.fill(ZERO);
    plaintext.fill(ZERO);
  }
};

// fallow-ignore-next-line code-duplication -- Pairing protection stays domain-owned rather than sharing the provider encryption boundary.
const decryptPairingDeliveryBytes = (key: Buffer, envelope: StoredDeliveryEnvelope): Buffer => {
  if (
    envelope.envelopeVersion !== DELIVERY_ENVELOPE_VERSION ||
    envelope.credentialVersion <= ZERO ||
    envelope.nonce.byteLength !== NONCE_BYTES ||
    envelope.authenticationTag.byteLength !== AUTHENTICATION_TAG_BYTES
  ) {
    throw pairingDeliveryUnavailableSignal;
  }
  const associatedData = deliveryAssociatedData(envelope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(envelope.authenticationTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    throw pairingDeliveryUnavailableSignal;
  } finally {
    associatedData.fill(ZERO);
  }
};

const decryptPairingDelivery = (key: Buffer, envelope: StoredDeliveryEnvelope): string => {
  const plaintext = decryptPairingDeliveryBytes(key, envelope);
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(ZERO);
  }
};

const protectedValuesMatch = (candidate: Buffer, stored: Buffer): boolean =>
  candidate.byteLength === stored.byteLength && timingSafeEqual(candidate, stored);

const isUnreadablePairingDelivery = (error: unknown): boolean =>
  error === pairingDeliveryUnavailableSignal;

export {
  type ApprovalFingerprintInput,
  type DeliveryContext,
  type PollingTokenDigestInput,
  type DeliveryEnvelope,
  type PairingProtectionKeys,
  type StoredDeliveryEnvelope,
  decryptPairingDelivery,
  derivePairingProtectionKeys,
  destroyPairingProtectionKeys,
  digestDeviceCredential,
  digestHumanCode,
  digestPollingToken,
  encryptPairingDelivery,
  fingerprintApproval,
  isUnreadablePairingDelivery,
  protectedValuesMatch,
};
