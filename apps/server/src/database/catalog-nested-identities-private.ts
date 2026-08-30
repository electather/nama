import { randomUUID } from "node:crypto";

import { and, eq, inArray, or } from "drizzle-orm";

import { providerArtworkMapping } from "./catalog-artwork-schema.ts";
import { insertBatches } from "./catalog-batches-private.ts";
import type {
  CatalogArtworkObservation,
  CatalogCreditObservation,
  CatalogProviderArtworkReference,
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { providerSourceMapping } from "./catalog-source-schema.ts";

const EMPTY_LENGTH = 0;

type ArtworkIdsByTargetReference = ReadonlyMap<string, ReadonlyMap<string, string>>;

interface ActiveArtwork extends CatalogArtworkObservation {
  readonly displayOrder: number;
  readonly targetItemReference: string;
}

const retainArtworkReference = (
  retainedReferences: Map<string, Set<string>>,
  reference: CatalogProviderArtworkReference,
): boolean => {
  const retainedForTarget = retainedReferences.get(reference.itemReference);
  if (retainedForTarget?.has(reference.artworkReference) === true) {
    return false;
  }
  if (retainedForTarget === undefined) {
    retainedReferences.set(reference.itemReference, new Set([reference.artworkReference]));
  } else {
    retainedForTarget.add(reference.artworkReference);
  }
  return true;
};

const appendPortraitArtwork = (
  artwork: ActiveArtwork[],
  retainedReferences: Map<string, Set<string>>,
  credit: CatalogCreditObservation,
): void => {
  const reference = credit.portraitArtworkReference;
  if (reference === undefined || !retainArtworkReference(retainedReferences, reference)) {
    return;
  }
  artwork.push({
    artworkReference: reference.artworkReference,
    asset: reference.asset,
    displayOrder: artwork.length,
    role: "portrait",
    targetItemReference: reference.itemReference,
    textPresence: "unknown",
  });
};

const collectActiveArtwork = (input: CatalogItemObservation): readonly ActiveArtwork[] => {
  const retainedReferences = new Map<string, Set<string>>();
  const artwork: ActiveArtwork[] = [];
  for (const observation of input.artwork) {
    const reference = {
      artworkReference: observation.artworkReference,
      itemReference: input.itemReference,
    };
    if (retainArtworkReference(retainedReferences, reference)) {
      artwork.push({
        ...observation,
        displayOrder: artwork.length,
        targetItemReference: input.itemReference,
      });
    }
  }
  for (const credit of input.credits) {
    appendPortraitArtwork(artwork, retainedReferences, credit);
  }
  return artwork;
};

interface ArtworkMappingRow {
  readonly artworkId: string;
  readonly artworkReference: string;
  readonly targetItemReference: string;
}

const activeArtworkCondition = (
  artwork: readonly ActiveArtwork[],
  canonicalItemId: string,
  input: CatalogItemObservation,
) => {
  const activeReferences = artwork.map((entry) => {
    const targetMatches = eq(providerArtworkMapping.targetItemReference, entry.targetItemReference);
    const artworkMatches = eq(providerArtworkMapping.artworkReference, entry.artworkReference);
    return and(targetMatches, artworkMatches);
  });
  return and(
    eq(providerArtworkMapping.providerInstanceId, input.providerInstanceId),
    eq(providerArtworkMapping.itemReference, input.itemReference),
    eq(providerArtworkMapping.canonicalItemId, canonicalItemId),
    or(...activeReferences),
  );
};

const artworkIdsByTarget = (rows: readonly ArtworkMappingRow[]): ArtworkIdsByTargetReference => {
  const artworkIds = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const idsForTarget = artworkIds.get(row.targetItemReference);
    if (idsForTarget === undefined) {
      artworkIds.set(row.targetItemReference, new Map([[row.artworkReference, row.artworkId]]));
    } else {
      idsForTarget.set(row.artworkReference, row.artworkId);
    }
  }
  return artworkIds;
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
}): Promise<ArtworkIdsByTargetReference> => {
  const candidates = artwork.map((entry) => ({
    artworkId: randomUUID(),
    artworkReference: entry.artworkReference,
    canonicalItemId,
    itemReference: input.itemReference,
    providerInstanceId: input.providerInstanceId,
    targetItemReference: entry.targetItemReference,
  }));
  await insertBatches(candidates, (batch) =>
    transaction.insert(providerArtworkMapping).values(batch).onConflictDoNothing(),
  );
  if (artwork.length === EMPTY_LENGTH) {
    return new Map();
  }
  const condition = activeArtworkCondition(artwork, canonicalItemId, input);
  const rows = await transaction
    .select({
      artworkId: providerArtworkMapping.artworkId,
      artworkReference: providerArtworkMapping.artworkReference,
      targetItemReference: providerArtworkMapping.targetItemReference,
    })
    .from(providerArtworkMapping)
    .where(condition);
  return artworkIdsByTarget(rows);
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

const artworkIdentityId = (
  reference: CatalogProviderArtworkReference | undefined,
  artworkIds: ArtworkIdsByTargetReference,
): string | undefined => {
  if (reference === undefined) {
    return undefined;
  }
  return artworkIds.get(reference.itemReference)?.get(reference.artworkReference);
};
export {
  type ArtworkIdsByTargetReference,
  type ActiveArtwork,
  collectActiveArtwork,
  artworkIdentityId,
  upsertArtworkMappings,
  upsertSourceMappings,
};
