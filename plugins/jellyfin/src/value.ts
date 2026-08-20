const EMPTY_LENGTH = 0;
const CODE_POINTS_PER_ITERATION = 1;

const hasMaximumCodePointLength = (value: string, maximum: number): boolean => {
  const iterator = value[Symbol.iterator]();
  let remaining = maximum;
  while (iterator.next().done !== true) {
    if (remaining <= EMPTY_LENGTH) {
      return false;
    }
    remaining -= CODE_POINTS_PER_ITERATION;
  }
  return true;
};

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export { hasMaximumCodePointLength, isUnknownRecord };
