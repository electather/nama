import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { createValidator, ValidationError } from "@bufbuild/protovalidate";
import type { Validator } from "@bufbuild/protovalidate";

import type { ContractFieldError } from "./field-errors.ts";
import { normalizeProtovalidateViolations } from "./request-validation-violations.ts";

type RequestValidationResult =
  | Readonly<{ kind: "valid" }>
  | Readonly<{ kind: "invalid"; fieldErrors: ContractFieldError[] }>
  | Readonly<{ kind: "defect" }>;

interface RequestValidator {
  validate: <Desc extends DescMessage>(
    schema: Desc,
    message: MessageShape<Desc>,
  ) => RequestValidationResult;
}

const VALID_RESULT: RequestValidationResult = { kind: "valid" };
const DEFECT_RESULT: RequestValidationResult = { kind: "defect" };

const normalizeValidResult = (result: object): RequestValidationResult => {
  if (
    Object.hasOwn(result, "message") &&
    Reflect.get(result, "error") === undefined &&
    Reflect.get(result, "violations") === undefined
  ) {
    return VALID_RESULT;
  }
  return DEFECT_RESULT;
};

const normalizeInvalidResult = (result: object, message: unknown): RequestValidationResult => {
  if (
    !Object.hasOwn(result, "message") ||
    !(Reflect.get(result, "error") instanceof ValidationError)
  ) {
    return DEFECT_RESULT;
  }
  const violations: unknown = Reflect.get(result, "violations");
  if (!Array.isArray(violations)) {
    return DEFECT_RESULT;
  }
  const fieldErrors = normalizeProtovalidateViolations(violations, message);
  if (fieldErrors === undefined) {
    return DEFECT_RESULT;
  }
  return { fieldErrors, kind: "invalid" };
};

const normalizeValidationResult = (result: unknown, message: unknown): RequestValidationResult => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return DEFECT_RESULT;
  }
  switch (Reflect.get(result, "kind")) {
    case "valid": {
      return normalizeValidResult(result);
    }
    case "invalid": {
      return normalizeInvalidResult(result, message);
    }
    case "error": {
      return DEFECT_RESULT;
    }
    default: {
      return DEFECT_RESULT;
    }
  }
};

const resolveValidator = (validator?: Validator): Validator | undefined => {
  try {
    return validator ?? createValidator();
  } catch {
    return undefined;
  }
};

const createRequestValidator = (validator?: Validator): RequestValidator => {
  const resolvedValidator = resolveValidator(validator);
  return {
    validate<Desc extends DescMessage>(
      schema: Desc,
      message: MessageShape<Desc>,
    ): RequestValidationResult {
      if (resolvedValidator === undefined) {
        return DEFECT_RESULT;
      }
      try {
        return normalizeValidationResult(resolvedValidator.validate(schema, message), message);
      } catch {
        return DEFECT_RESULT;
      }
    },
  };
};

export { createRequestValidator };
export type { RequestValidationResult, RequestValidator };
