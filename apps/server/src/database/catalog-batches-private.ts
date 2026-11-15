const FIRST_INDEX = 0;
const NEXT_INDEX_OFFSET = 1;
const INSERT_BATCH_SIZE = 500;

const insertSequentially = async <Row>(
  batches: readonly [Row, ...Row[]][],
  index: number,
  insert: (batch: [Row, ...Row[]]) => Promise<unknown>,
): Promise<void> => {
  const batch = batches[index];
  if (batch === undefined) {
    return;
  }
  await insert(batch);
  await insertSequentially(batches, index + NEXT_INDEX_OFFSET, insert);
};

const insertBatches = async <Row>(
  rows: readonly Row[],
  insert: (batch: [Row, ...Row[]]) => Promise<unknown>,
): Promise<void> => {
  const batches: [Row, ...Row[]][] = [];
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const [first, ...remaining] = batch;
    if (first !== undefined) {
      batches.push([first, ...remaining]);
    }
  }
  await insertSequentially(batches, FIRST_INDEX, insert);
};

export { insertBatches };
