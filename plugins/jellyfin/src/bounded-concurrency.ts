const FIRST_INDEX = 0;
const INDEX_INCREMENT = 1;

const forEachBounded = async <Value>(
  values: readonly Value[],
  maximumConcurrency: number,
  visit: (value: Value, index: number) => Promise<void>,
): Promise<void> => {
  let nextIndex = FIRST_INDEX;
  const visitNext = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += INDEX_INCREMENT;
    const value = values[index];
    if (value === undefined) {
      return;
    }
    await visit(value, index);
    await visitNext();
  };
  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, values.length) }, () => visitNext()),
  );
};

export { forEachBounded };
