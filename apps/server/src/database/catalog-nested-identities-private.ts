import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { providerArtworkMapping } from "./catalog-artwork-schema.ts";
import { insertBatches } from "./catalog-batches-private.ts";
import type {
  CatalogArtworkObservation,
  CatalogCreditObservation,
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { providerSourceMapping } from "./catalog-source-schema.ts";

const EMPTY_LENGTH = 0;

interface ActiveArtwork extends CatalogArtworkObservation {
  readonly displayOrder: number;
}

const appendPortraitArtwork = (
  artwork: ActiveArtwork[],
  retainedReferences: Set<string>,
  credit: CatalogCreditObservation,
): void => {
  const reference = credit.portraitArtworkReference;
  if (reference === undefined || retainedReferences.has(reference)) {
    return;
  }
  retainedReferences.add(reference);
  artwork.push({
    artworkReference: reference,
    displayOrder: artwork.length,
    role: "portrait",
    textPresence: "unknown",
  });
};

const collectActiveArtwork = (input: CatalogItemObservation): readonly ActiveArtwork[] => {
  const retainedReferences = new Set<string>();
  const artwork: ActiveArtwork[] = [];
  for (const observation of input.artwork) {
    if (!retainedReferences.has(observation.artworkReference)) {
      retainedReferences.add(observation.artworkReference);
      artwork.push({ ...observation, displayOrder: artwork.length });
    }
  }
  for (const credit of input.credits) {
    appendPortraitArtwork(artwork, retainedReferences, credit);
  }
  return artwork;
};

const upsertArtworkMappings = async ({
  artwork,
  canonicalItemId,
  input,
  transaction,
}: {
  readonly artwork: readonly ActiveArtwork[];
  readonly canonicalItemId: string;
  readonly input: CatalogItemObservation;
  readonly transaction: CatalogTransaction;
}): Promise<ReadonlyMap<string, string>> => {
  const candidates = artwork.map((entry) => ({
    artworkId: randomUUID(),
    artworkReference: entry.artworkReference,
    canonicalItemId,
    itemReference: input.itemReference,
    providerInstanceId: input.providerInstanceId,
  }));
  await insertBatches(candidates, (batch) =>
    transaction.insert(providerArtworkMapping).values(batch).onConflictDoNothing(),
  );
  if (artwork.length === EMPTY_LENGTH) {
    return new Map();
  }
  const references = artwork.map((entry) => entry.artworkReference);
  const rows = await transaction
    .select({
      artworkId: providerArtworkMapping.artworkId,
      artworkReference: providerArtworkMapping.artworkReference,
    })
    .from(providerArtworkMapping)
    .where(
      and(
        eq(providerArtworkMapping.providerInstanceId, input.providerInstanceId),
        eq(providerArtworkMapping.itemReference, input.itemReference),
        inArray(providerArtworkMapping.artworkReference, references),
      ),
    );
  return new Map(rows.map((row) => [row.artworkReference, row.artworkId]));
};

const upsertSourceMappings = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  canonicalItemId: string,
): Promise<ReadonlyMap<string, string>> => {
  const candidates = input.sources.map((source) => ({
    canonicalItemId,
    itemReference: input.itemReference,
    providerInstanceId: input.providerInstanceId,
    sourceId: randomUUID(),
    sourceReference: source.sourceReference,
  }));
  await insertBatches(candidates, (batch) =>
    transaction.insert(providerSourceMapping).values(batch).onConflictDoNothing(),
  );
  if (input.sources.length === EMPTY_LENGTH) {
    return new Map();
  }
  const references = input.sources.map((source) => source.sourceReference);
  const rows = await transaction
    .select({
      sourceId: providerSourceMapping.sourceId,
      sourceReference: providerSourceMapping.sourceReference,
    })
    .from(providerSourceMapping)
    .where(
      and(
        eq(providerSourceMapping.providerInstanceId, input.providerInstanceId),
        eq(providerSourceMapping.itemReference, input.itemReference),
        inArray(providerSourceMapping.sourceReference, references),
      ),
    );
  return new Map(rows.map((row) => [row.sourceReference, row.sourceId]));
};

const portraitArtworkId = (
  reference: string | undefined,
  artworkIds: ReadonlyMap<string, string>,
): string | undefined => {
  if (reference === undefined) {
    return undefined;
  }
  return artworkIds.get(reference);
};
export {
  type ActiveArtwork,
  collectActiveArtwork,
  portraitArtworkId,
  upsertArtworkMappings,
  upsertSourceMappings,
};
