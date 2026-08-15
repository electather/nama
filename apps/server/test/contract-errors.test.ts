import { expect, test } from "vitest";

import type { ContractFieldError, ContractFieldErrorInput } from "../src/contract-errors.ts";
import { normalizeContractFieldErrors } from "../src/contract-errors.ts";

const approvedViolations = [
  {
    description: "cannot clear a field also present in configuration_patch",
    field: "clear_configuration_fields[0]",
    reason: "CONFLICT",
  },
  {
    description: "required by the selected provider schema",
    field: "configuration.api_key",
    reason: "REQUIRED",
  },
  {
    description: "must be an absolute HTTP or HTTPS URL",
    field: "configuration.base_url",
    localizedMessage: { locale: "en", message: "Enter a valid server URL." },
    reason: "INVALID_FORMAT",
  },
  {
    description: "cannot set a field also present in clear_configuration_fields",
    field: "configuration_patch.api_key",
    reason: "CONFLICT",
  },
  {
    description: "must be positive when quality is CAPPED",
    field: "max_bit_rate_bps",
    reason: "MISMATCH",
  },
  {
    description: "must omit max_bit_rate_bps unless quality is CAPPED",
    field: "quality",
    reason: "MISMATCH",
  },
] as const;

const FIELD_ERROR_LIMIT = 50;
const FIELD_ERROR_INPUT_COUNT = 51;
const FIELD_NUMBER_WIDTH = 2;

interface PrivateViolation extends ContractFieldErrorInput {
  readonly providerReference: string;
}

const expectCopiedError = (error: ContractFieldError, source: PrivateViolation): void => {
  expect(error).not.toBe(source);
  if (error.localizedMessage === undefined) {
    expect(Object.keys(error).toSorted()).toEqual(["description", "field", "reason"]);
    return;
  }
  expect(Object.keys(error).toSorted()).toEqual([
    "description",
    "field",
    "localizedMessage",
    "reason",
  ]);
  expect(error.localizedMessage).not.toBe(source.localizedMessage);
  expect(Object.keys(error.localizedMessage).toSorted()).toEqual(["locale", "message"]);
};

const expectCopiedErrors = (
  errors: readonly ContractFieldError[],
  sources: readonly PrivateViolation[],
): void => {
  for (const error of errors) {
    const source = sources.find((violation) => violation.field === error.field);
    if (source === undefined) {
      throw new Error(`missing source violation for ${error.field}`);
    }
    expectCopiedError(error, source);
  }
};

test("field errors are sorted, copied, and stripped of private metadata", () => {
  const reversedViolations: PrivateViolation[] = structuredClone(
    approvedViolations.toReversed(),
  ).map((violation) => Object.assign(violation, { providerReference: "private" }));
  const inputSnapshot = structuredClone(reversedViolations);

  const result = normalizeContractFieldErrors(reversedViolations);

  expect(result).toEqual(approvedViolations);
  expect(reversedViolations).toEqual(inputSnapshot);
  expectCopiedErrors(result, reversedViolations);
});

test("field errors retain only the first 50 sorted entries", () => {
  const reversedViolations = Array.from({ length: FIELD_ERROR_INPUT_COUNT }, (_unused, index) => {
    const fieldNumber = FIELD_ERROR_LIMIT - index;
    return {
      description: `description ${fieldNumber}`,
      field: `field_${fieldNumber.toString().padStart(FIELD_NUMBER_WIDTH, "0")}`,
      providerReference: `private ${fieldNumber}`,
      reason: "INVALID_FORMAT",
    };
  });

  const result = normalizeContractFieldErrors(reversedViolations);

  expect(result).toHaveLength(FIELD_ERROR_LIMIT);
  expect(result.map(({ field }) => field)).toEqual(
    Array.from(
      { length: FIELD_ERROR_LIMIT },
      (_unused, index) => `field_${index.toString().padStart(FIELD_NUMBER_WIDTH, "0")}`,
    ),
  );
  expect(result.some(({ field }) => field === "field_50")).toBe(false);
});
