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
const CREDENTIAL_ENVELOPE_VERSION = 1;
const EMPTY_HKDF_SALT = Buffer.alloc(ZERO);
const ENVELOPE_VERSION_BYTES = Buffer.from([CREDENTIAL_ENVELOPE_VERSION]);
const HKDF_HASH = "sha256";
const KEY_BYTES = 32;
const LENGTH_PREFIX_BYTES = 4;
const NONCE_BYTES = 12;
const PROVIDER_CREDENTIAL_INFO = Buffer.from("nama/provider-credentials/v1", "utf8");
const PROVIDER_OPERATION_INFO = Buffer.from("nama/provider-operations/v1", "utf8");
const PROVIDER_PRINCIPAL_INFO = Buffer.from("nama/provider-principals/v1", "utf8");
const deriveHkdfOutput = promisify(hkdf);

class UnreadableCredentialError extends Error {
  override readonly name = "UnreadableCredentialError";
}

const credentialUnavailableSignal = new UnreadableCredentialError(
  "Provider credential is unavailable",
);

interface ProtectionKeys {
  readonly credential: Buffer;
  readonly operation: Buffer;
  readonly principal: Buffer;
}

interface CredentialContext {
  readonly configurationKey: string;
  readonly providerInstanceId: string;
  readonly providerTypeId: string;
}

interface CredentialEnvelope {
  readonly authenticationTag: Buffer;
  readonly ciphertext: Buffer;
  readonly envelopeVersion: number;
  readonly nonce: Buffer;
}

interface StoredCredentialEnvelope extends CredentialContext, CredentialEnvelope {}

interface PrincipalContext {
  readonly providerInstanceId: string;
  readonly providerTypeId: string;
}

interface OperationFingerprintInput {
  readonly administratorUserId: string;
  readonly canonicalRequest: Uint8Array;
  readonly method: string;
}

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

const deriveKey = async (masterKey: Buffer, info: Buffer): Promise<Buffer> =>
  Buffer.from(await deriveHkdfOutput(HKDF_HASH, masterKey, EMPTY_HKDF_SALT, info, KEY_BYTES));

const deriveProtectionKeys = async (encodedMasterKey: string): Promise<ProtectionKeys> => {
  const masterKey = Buffer.from(encodedMasterKey.slice("base64:".length), "base64");
  try {
    const [credential, operation, principal] = await Promise.all([
      deriveKey(masterKey, PROVIDER_CREDENTIAL_INFO),
      deriveKey(masterKey, PROVIDER_OPERATION_INFO),
      deriveKey(masterKey, PROVIDER_PRINCIPAL_INFO),
    ]);
    return { credential, operation, principal };
  } finally {
    masterKey.fill(ZERO);
  }
};

const destroyProtectionKeys = (keys: ProtectionKeys): void => {
  keys.credential.fill(ZERO);
  keys.operation.fill(ZERO);
  keys.principal.fill(ZERO);
};

const credentialAssociatedData = (context: CredentialContext): Buffer =>
  frame([
    ENVELOPE_VERSION_BYTES,
    Buffer.from(context.providerTypeId, "utf8"),
    Buffer.from(context.providerInstanceId, "utf8"),
    Buffer.from(context.configurationKey, "utf8"),
  ]);

const encryptCredential = (
  key: Buffer,
  context: CredentialContext,
  value: string,
): CredentialEnvelope => {
  const nonce = randomBytes(NONCE_BYTES);
  const associatedData = credentialAssociatedData(context);
  const plaintext = Buffer.from(value, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      authenticationTag: cipher.getAuthTag(),
      ciphertext,
      envelopeVersion: CREDENTIAL_ENVELOPE_VERSION,
      nonce,
    };
  } finally {
    associatedData.fill(ZERO);
    plaintext.fill(ZERO);
  }
};

const decryptCredentialBytes = (key: Buffer, envelope: StoredCredentialEnvelope): Buffer => {
  if (
    envelope.envelopeVersion !== CREDENTIAL_ENVELOPE_VERSION ||
    envelope.nonce.byteLength !== NONCE_BYTES ||
    envelope.authenticationTag.byteLength !== AUTHENTICATION_TAG_BYTES
  ) {
    throw credentialUnavailableSignal;
  }

  const associatedData = credentialAssociatedData(envelope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(envelope.authenticationTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    throw credentialUnavailableSignal;
  } finally {
    associatedData.fill(ZERO);
  }
};

const authenticateCredential = (key: Buffer, envelope: StoredCredentialEnvelope): void => {
  const plaintext = decryptCredentialBytes(key, envelope);
  plaintext.fill(ZERO);
};

const decryptCredential = (key: Buffer, envelope: StoredCredentialEnvelope): string => {
  const plaintext = decryptCredentialBytes(key, envelope);
  try {
    return plaintext.toString("utf8");
  } finally {
    plaintext.fill(ZERO);
  }
};

const digestPrincipal = (
  key: Buffer,
  context: PrincipalContext,
  principalReference: string,
): Buffer => {
  const input = frame([
    ENVELOPE_VERSION_BYTES,
    Buffer.from(context.providerTypeId, "utf8"),
    Buffer.from(context.providerInstanceId, "utf8"),
    Buffer.from(principalReference, "utf8"),
  ]);
  try {
    return createHmac("sha256", key).update(input).digest();
  } finally {
    input.fill(ZERO);
  }
};

const fingerprintOperation = (key: Buffer, input: OperationFingerprintInput): Buffer => {
  const framed = frame([
    ENVELOPE_VERSION_BYTES,
    Buffer.from(input.administratorUserId, "utf8"),
    Buffer.from(input.method, "utf8"),
    input.canonicalRequest,
  ]);
  try {
    return createHmac("sha256", key).update(framed).digest();
  } finally {
    framed.fill(ZERO);
  }
};

const principalDigestsMatch = (candidate: Buffer, stored: Buffer): boolean =>
  timingSafeEqual(candidate, stored);

const isUnreadableCredential = (error: unknown): boolean => error === credentialUnavailableSignal;

export {
  type CredentialContext,
  type CredentialEnvelope,
  type OperationFingerprintInput,
  type PrincipalContext,
  type ProtectionKeys,
  type StoredCredentialEnvelope,
  credentialUnavailableSignal,
  authenticateCredential,
  decryptCredential,
  deriveProtectionKeys,
  destroyProtectionKeys,
  digestPrincipal,
  encryptCredential,
  fingerprintOperation,
  isUnreadableCredential,
  principalDigestsMatch,
};
