type ContractFieldErrorInput = Readonly<{
  field: string;
  reason: string;
  description: string;
  localizedMessage?: Readonly<{ locale: string; message: string }>;
}>;

type ContractFieldError = Readonly<{
  field: string;
  reason: string;
  description: string;
  localizedMessage?: Readonly<{ locale: string; message: string }>;
}>;

const BEFORE = -1;
const EQUAL = 0;
const AFTER = 1;
const FIRST_FIELD_ERROR_INDEX = 0;
const FIELD_ERROR_LIMIT = 50;

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return BEFORE;
  }
  if (left > right) {
    return AFTER;
  }
  return EQUAL;
};

const normalizeContractFieldErrors = (
  violations: readonly ContractFieldErrorInput[],
): ContractFieldError[] =>
  violations
    .toSorted((left, right) => {
      for (const key of ["field", "reason", "description"] as const) {
        const order = compareCodeUnits(left[key], right[key]);
        if (order !== EQUAL) {
          return order;
        }
      }
      return EQUAL;
    })
    .slice(FIRST_FIELD_ERROR_INDEX, FIELD_ERROR_LIMIT)
    .map(({ description, field, localizedMessage, reason }): ContractFieldError => {
      if (localizedMessage === undefined) {
        return { description, field, reason };
      }
      return {
        description,
        field,
        localizedMessage: {
          locale: localizedMessage.locale,
          message: localizedMessage.message,
        },
        reason,
      };
    });

export { normalizeContractFieldErrors, type ContractFieldError, type ContractFieldErrorInput };
