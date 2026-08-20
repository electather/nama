const forEachBounded = async <Value, Result>(
  values: readonly Value[],
  maximumConcurrency: number,
  visit: (value: Value, index: number) => Promise<Result>,
): Promise<Result[]> => {
  const entries = values.entries();
  const resultsByIndex = new Map<number, Readonly<{ result: Result }>>();
  const visitNext = async (): Promise<void> => {
    const entry = entries.next();
    if (entry.done === true) {
      return;
    }
    const [index, value] = entry.value;
    resultsByIndex.set(index, { result: await visit(value, index) });
    await visitNext();
  };
  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, values.length) }, () => visitNext()),
  );
  return values.map((_value, index) => {
    const completed = resultsByIndex.get(index);
    if (completed === undefined) {
      throw new Error("Bounded result is unavailable");
    }
    return completed.result;
  });
};

export { forEachBounded };
