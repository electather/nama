import { randomBytes } from "node:crypto";

import {
  PairingCodeInvalid,
  PairingDisplayNameInvalid,
} from "./pairing-persistence-model-private.ts";
import type { PairingValueSource } from "./pairing-persistence-model-private.ts";

const HUMAN_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const HUMAN_CODE_CHARACTERS = 8;
const HUMAN_CODE_GROUP_CHARACTERS = 4;
const ID_BYTES = 18;
const SECRET_BYTES = 32;
const MAXIMUM_DISPLAY_NAME_CODE_POINTS = 256;
const MAXIMUM_OPERATION_ID_CODE_POINTS = 256;
const MAXIMUM_PAIRING_ID_CODE_POINTS = 256;
const HUMAN_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{8}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CREDENTIAL_VERSION = 1;
const ZERO = 0;
const CODE_POINT_INCREMENT = 1;

const securePairingValueSource: PairingValueSource = Object.freeze({
  deviceId: () => randomBytes(ID_BYTES).toString("base64url"),
  humanCode: () => {
    const random = randomBytes(HUMAN_CODE_CHARACTERS);
    let code = "";
    for (const value of random) {
      code += HUMAN_CODE_ALPHABET[value % HUMAN_CODE_ALPHABET.length];
    }
    random.fill(ZERO);
    return code;
  },
  pairingId: () => randomBytes(ID_BYTES).toString("base64url"),
  secret: () => randomBytes(SECRET_BYTES).toString("base64url"),
});

const codePointLength = (value: string): number => {
  let length = ZERO;
  for (const codePoint of value) {
    if (codePoint.length > ZERO) {
      length += CODE_POINT_INCREMENT;
    }
  }
  return length;
};

const normalizeDisplayName = (displayName: string): string => {
  const normalized = displayName.trim();
  const length = codePointLength(normalized);
  if (length === ZERO || length > MAXIMUM_DISPLAY_NAME_CODE_POINTS) {
    throw new PairingDisplayNameInvalid({});
  }
  return normalized;
};

const normalizeHumanCode = (userCode: string): string => {
  const normalized = userCode.replaceAll(/[\s-]/gu, "").toUpperCase();
  if (!HUMAN_CODE_PATTERN.test(normalized)) {
    throw new PairingCodeInvalid({});
  }
  return normalized;
};

const formatHumanCode = (normalizedCode: string): string =>
  `${normalizedCode.slice(ZERO, HUMAN_CODE_GROUP_CHARACTERS)}-${normalizedCode.slice(HUMAN_CODE_GROUP_CHARACTERS)}`;

const isValidCredential = (version: number, secret: string): boolean =>
  version === CREDENTIAL_VERSION && SECRET_PATTERN.test(secret);

const isValidPairingId = (pairingId: string): boolean => {
  const length = codePointLength(pairingId);
  return length > ZERO && length <= MAXIMUM_PAIRING_ID_CODE_POINTS;
};

const isValidOperationId = (operationId: string): boolean => {
  const length = codePointLength(operationId);
  return length > ZERO && length <= MAXIMUM_OPERATION_ID_CODE_POINTS;
};

export {
  CREDENTIAL_VERSION,
  formatHumanCode,
  isValidCredential,
  isValidOperationId,
  isValidPairingId,
  normalizeDisplayName,
  normalizeHumanCode,
  securePairingValueSource,
};
