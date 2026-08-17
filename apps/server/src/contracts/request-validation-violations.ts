import { pathToString } from "@bufbuild/protobuf/reflect";
import type { Path } from "@bufbuild/protobuf/reflect";

import { normalizeContractFieldErrors } from "./field-errors.ts";
import type { ContractFieldError, ContractFieldErrorInput } from "./field-errors.ts";

type FieldErrorPolicy = Readonly<{
  description: string;
  reason: string;
}>;

const MINIMUM_PATH_LIST_INDEX = 0;
const RULE_NAME_SEPARATOR = ".";
const RULE_NAME_START_OFFSET = 1;
const TOP_LEVEL_FIELD_PATH_LENGTH = 1;

const REQUIRED_FIELD_ERROR: FieldErrorPolicy = {
  description: "is required",
  reason: "REQUIRED",
};
const INVALID_FORMAT_FIELD_ERROR: FieldErrorPolicy = {
  description: "has an invalid format",
  reason: "INVALID_FORMAT",
};
const OUT_OF_RANGE_FIELD_ERROR: FieldErrorPolicy = {
  description: "is outside the permitted range",
  reason: "OUT_OF_RANGE",
};
const UNSUPPORTED_VALUE_FIELD_ERROR: FieldErrorPolicy = {
  description: "has an unsupported value",
  reason: "UNSUPPORTED_VALUE",
};
const MISMATCH_FIELD_ERROR: FieldErrorPolicy = {
  description: "does not match",
  reason: "MISMATCH",
};
const CONFLICT_FIELD_ERROR: FieldErrorPolicy = {
  description: "conflicts with another value",
  reason: "CONFLICT",
};

const FORMAT_RULE_NAMES: Record<string, true> = {
  address: true,
  email: true,
  host_and_port: true,
  hostname: true,
  ip: true,
  ip_prefix: true,
  ipv4: true,
  ipv6: true,
  pattern: true,
  uri: true,
  uri_ref: true,
  uuid: true,
  well_known_regex: true,
};
const RANGE_RULE_NAMES: Record<string, true> = {
  gt: true,
  gte: true,
  len: true,
  len_bytes: true,
  lt: true,
  lte: true,
  max: true,
  max_bytes: true,
  max_items: true,
  max_len: true,
  max_pairs: true,
  min: true,
  min_bytes: true,
  min_items: true,
  min_len: true,
  min_pairs: true,
};
const UNSUPPORTED_VALUE_RULE_NAMES: Record<string, true> = {
  const: true,
  defined_only: true,
  in: true,
  not_in: true,
};
const MISMATCH_RULE_NAMES: Record<string, true> = {
  equal: true,
  equals: true,
  match: true,
  matches: true,
  same: true,
  same_as: true,
};
const CONFLICT_RULE_NAMES: Record<string, true> = {
  conflict: true,
  conflicts: true,
  different: true,
  exclusive: true,
  mutually_exclusive: true,
  not_equal: true,
};
const PATH_ELEMENT_STRING_PROPERTY_BY_KIND: Record<string, string> = {
  extension: "typeName",
  field: "name",
  oneof: "name",
};
const RULE_NAME_POLICIES: readonly (readonly [Record<string, true>, FieldErrorPolicy])[] = [
  [FORMAT_RULE_NAMES, INVALID_FORMAT_FIELD_ERROR],
  [RANGE_RULE_NAMES, OUT_OF_RANGE_FIELD_ERROR],
  [UNSUPPORTED_VALUE_RULE_NAMES, UNSUPPORTED_VALUE_FIELD_ERROR],
  [MISMATCH_RULE_NAMES, MISMATCH_FIELD_ERROR],
  [CONFLICT_RULE_NAMES, CONFLICT_FIELD_ERROR],
];

const isNonnegativePathListIndex = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= MINIMUM_PATH_LIST_INDEX;

const isPathMapKey = (value: unknown): boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean";

const hasKnownPathElementShape = (element: object, kind: string): boolean => {
  if (Object.hasOwn(PATH_ELEMENT_STRING_PROPERTY_BY_KIND, kind)) {
    const stringProperty = PATH_ELEMENT_STRING_PROPERTY_BY_KIND[kind];
    if (stringProperty === undefined) {
      return false;
    }
    return typeof Reflect.get(element, stringProperty) === "string";
  }
  if (kind === "list_sub") {
    return isNonnegativePathListIndex(Reflect.get(element, "index"));
  }
  if (kind === "map_sub") {
    return isPathMapKey(Reflect.get(element, "key"));
  }
  return false;
};

const isPathElement = (element: unknown): boolean => {
  if (typeof element !== "object" || element === null || Array.isArray(element)) {
    return false;
  }
  const kind: unknown = Reflect.get(element, "kind");
  return typeof kind === "string" && hasKnownPathElementShape(element, kind);
};

const isPath = (value: unknown): value is Path =>
  Array.isArray(value) && value.every((element) => isPathElement(element));

const hasEmptyTextAtFieldPath = (message: unknown, fieldPath: Path): boolean => {
  const [field] = fieldPath;
  return (
    fieldPath.length === TOP_LEVEL_FIELD_PATH_LENGTH &&
    field?.kind === "field" &&
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, field.localName) === ""
  );
};

const policyForRuleName = (name: string): FieldErrorPolicy | undefined => {
  for (const [ruleNames, policy] of RULE_NAME_POLICIES) {
    if (Object.hasOwn(ruleNames, name)) {
      return policy;
    }
  }
  return undefined;
};

const policyForViolation = (
  ruleId: string,
  message: unknown,
  fieldPath: Path,
): FieldErrorPolicy | undefined => {
  const ruleNameStart = ruleId.lastIndexOf(RULE_NAME_SEPARATOR) + RULE_NAME_START_OFFSET;
  const name = ruleId.slice(ruleNameStart);
  if (
    name === "required" ||
    name === "legacy_required" ||
    (name === "min_len" && hasEmptyTextAtFieldPath(message, fieldPath))
  ) {
    return REQUIRED_FIELD_ERROR;
  }
  return policyForRuleName(name);
};

const toContractFieldError = (
  violation: unknown,
  message: unknown,
): ContractFieldErrorInput | undefined => {
  if (typeof violation !== "object" || violation === null || Array.isArray(violation)) {
    return undefined;
  }
  const fieldPath: unknown = Reflect.get(violation, "field");
  const ruleId: unknown = Reflect.get(violation, "ruleId");
  if (typeof ruleId !== "string" || !isPath(fieldPath)) {
    return undefined;
  }
  const policy = policyForViolation(ruleId, message, fieldPath);
  if (policy === undefined) {
    return undefined;
  }
  return {
    description: policy.description,
    field: pathToString(fieldPath),
    reason: policy.reason,
  };
};

const normalizeProtovalidateViolations = (
  violations: readonly unknown[],
  message: unknown,
): ContractFieldError[] | undefined => {
  const fieldErrors: ContractFieldErrorInput[] = [];
  for (const violation of violations) {
    const fieldError = toContractFieldError(violation, message);
    if (fieldError === undefined) {
      return undefined;
    }
    fieldErrors.push(fieldError);
  }
  return normalizeContractFieldErrors(fieldErrors);
};

export { normalizeProtovalidateViolations };
