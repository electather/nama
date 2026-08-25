import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { insertBatches } from "./catalog-batches-private.ts";
import { repairHierarchy, reconcileLibraryEntries } from "./catalog-hierarchy-private.ts";
import {
  canonicalItem,
  providerExternalIdentifier,
  providerItemMapping,
  providerItemParentReference,
} from "./catalog-item-schema.ts";
import { replaceNestedCatalogRecords } from "./catalog-nested-private.ts";
import type {
  CatalogDatabase,
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { refreshSearchProjection } from "./catalog-search-private.ts";
import { providerInstance } from "./provider-schema.ts";

const EMPTY_LENGTH = 0;
const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;
const SQL_NULL = sql`null`;

const commonItemProjection = (input: CatalogItemObservation) => ({
  contentRating: input.contentRating ?? SQL_NULL,
  episodeCount: SQL_NULL,
  episodeNumber: SQL_NULL,
  firstReleaseDate: SQL_NULL,
  genres: [...input.genres],
  kind: input.kind,
  lastReleaseDate: SQL_NULL,
  originalTitle: input.originalTitle ?? SQL_NULL,
  releaseDate: SQL_NULL,
  releaseYear: input.releaseYear ?? SQL_NULL,
  runtimeNanoseconds: input.runtime.nanoseconds,
  runtimeSeconds: input.runtime.seconds,
  seasonCount: SQL_NULL,
  seasonNumber: SQL_NULL,
  studios: [...input.studios],
  synopsis: input.synopsis ?? SQL_NULL,
  tagline: input.tagline ?? SQL_NULL,
  title: input.title,
  updatedAt: sql`transaction_timestamp()`,
});

const episodeItemProjection = (
  input: Extract<CatalogItemObservation, { readonly kind: "episode" }>,
) => ({
  ...commonItemProjection(input),
  episodeNumber: input.episodeNumber,
  releaseDate: input.releaseDate ?? SQL_NULL,
  seasonNumber: input.seasonNumber,
});
const movieItemProjection = (
  input: Extract<CatalogItemObservation, { readonly kind: "movie" }>,
) => ({
  ...commonItemProjection(input),
  releaseDate: input.releaseDate ?? SQL_NULL,
});
const seasonItemProjection = (
  input: Extract<CatalogItemObservation, { readonly kind: "season" }>,
) => ({
  ...commonItemProjection(input),
  episodeCount: input.episodeCount ?? SQL_NULL,
  seasonNumber: input.seasonNumber,
});
const showItemProjection = (input: Extract<CatalogItemObservation, { readonly kind: "show" }>) => ({
  ...commonItemProjection(input),
  episodeCount: input.episodeCount ?? SQL_NULL,
  firstReleaseDate: input.firstReleaseDate ?? SQL_NULL,
  lastReleaseDate: input.lastReleaseDate ?? SQL_NULL,
  seasonCount: input.seasonCount ?? SQL_NULL,
});

const episodeParentReferences = (
  input: Extract<CatalogItemObservation, { readonly kind: "episode" }>,
) =>
  [
    {
      childItemReference: input.itemReference,
      expectedParentKind: "season",
      parentItemReference: input.seasonReference,
      providerInstanceId: input.providerInstanceId,
      relationship: "season",
    },
    {
      childItemReference: input.itemReference,
      expectedParentKind: "show",
      parentItemReference: input.showReference,
      providerInstanceId: input.providerInstanceId,
      relationship: "show",
    },
  ] as const;

const seasonParentReferences = (
  input: Extract<CatalogItemObservation, { readonly kind: "season" }>,
) =>
  [
    {
      childItemReference: input.itemReference,
      expectedParentKind: "show",
      parentItemReference: input.showReference,
      providerInstanceId: input.providerInstanceId,
      relationship: "show",
    },
  ] as const;

const catalogProjection = (input: CatalogItemObservation) => {
  switch (input.kind) {
    case "episode": {
      return {
        item: episodeItemProjection(input),
        parentReferences: episodeParentReferences(input),
      };
    }
    case "movie": {
      return { item: movieItemProjection(input), parentReferences: [] };
    }
    case "season": {
      return { item: seasonItemProjection(input), parentReferences: seasonParentReferences(input) };
    }
    case "show": {
      return { item: showItemProjection(input), parentReferences: [] };
    }
    default: {
      throw new Error("catalog item observation kind is invalid");
    }
  }
};

type CatalogProjection = ReturnType<typeof catalogProjection>;

const lockProviderCatalog = async (
  transaction: CatalogTransaction,
  providerInstanceId: string,
): Promise<void> => {
  const rows = await transaction
    .select({ id: providerInstance.id })
    .from(providerInstance)
    .where(eq(providerInstance.id, providerInstanceId))
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  if (rows[FIRST_ROW] === undefined) {
    throw new Error("catalog provider instance is missing");
  }
};

interface ExistingExactMapping {
  readonly canonicalItemId: string;
  readonly kind: string;
}

const refreshExactMapping = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  existing: ExistingExactMapping,
): Promise<string> => {
  if (existing.kind !== input.kind) {
    throw new Error("provider item kind changed for an exact mapping");
  }
  await transaction
    .update(providerItemMapping)
    .set({
      lastSeenAt: sql`transaction_timestamp()`,
      lastSeenScanRunId: input.lastSeenScanRunId ?? SQL_NULL,
    })
    .where(
      and(
        eq(providerItemMapping.providerInstanceId, input.providerInstanceId),
        eq(providerItemMapping.itemReference, input.itemReference),
      ),
    );
  return existing.canonicalItemId;
};

const createExactMapping = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  projection: CatalogProjection,
): Promise<string> => {
  const canonicalItemId = randomUUID();
  await transaction.insert(canonicalItem).values({ id: canonicalItemId, ...projection.item });
  await transaction.insert(providerItemMapping).values({
    canonicalItemId,
    itemReference: input.itemReference,
    lastSeenScanRunId: input.lastSeenScanRunId ?? SQL_NULL,
    providerInstanceId: input.providerInstanceId,
  });
  return canonicalItemId;
};

const resolveExactMapping = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  projection: CatalogProjection,
): Promise<string> => {
  await lockProviderCatalog(transaction, input.providerInstanceId);
  const existingRows = await transaction
    .select({ canonicalItemId: providerItemMapping.canonicalItemId, kind: canonicalItem.kind })
    .from(providerItemMapping)
    .innerJoin(canonicalItem, eq(canonicalItem.id, providerItemMapping.canonicalItemId))
    .where(
      and(
        eq(providerItemMapping.providerInstanceId, input.providerInstanceId),
        eq(providerItemMapping.itemReference, input.itemReference),
      ),
    )
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  const existing = existingRows[FIRST_ROW];
  if (existing === undefined) {
    return createExactMapping(transaction, input, projection);
  }
  return refreshExactMapping(transaction, input, existing);
};

const replaceExternalIdentifierEvidence = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
): Promise<void> => {
  await transaction
    .delete(providerExternalIdentifier)
    .where(
      and(
        eq(providerExternalIdentifier.providerInstanceId, input.providerInstanceId),
        eq(providerExternalIdentifier.itemReference, input.itemReference),
      ),
    );
  const identifiers = new Map<string, { readonly namespace: string; readonly value: string }>();
  for (const identifier of input.externalIdentifiers) {
    const namespace = identifier.namespace.trim().toLowerCase();
    const value = identifier.value.trim();
    identifiers.set(`${namespace}\u0000${value}`, { namespace, value });
  }
  const rows = [...identifiers.values()].map((identifier) => ({
    itemReference: input.itemReference,
    namespace: identifier.namespace,
    providerInstanceId: input.providerInstanceId,
    value: identifier.value,
  }));
  await insertBatches(rows, (batch) =>
    transaction.insert(providerExternalIdentifier).values(batch),
  );
};

const replaceParentEvidence = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  rows: CatalogProjection["parentReferences"],
): Promise<void> => {
  await transaction
    .delete(providerItemParentReference)
    .where(
      and(
        eq(providerItemParentReference.providerInstanceId, input.providerInstanceId),
        eq(providerItemParentReference.childItemReference, input.itemReference),
      ),
    );
  if (rows.length > EMPTY_LENGTH) {
    await transaction.insert(providerItemParentReference).values([...rows]);
  }
};

const replaceCanonicalItemInTransaction = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
): Promise<string> => {
  const projection = catalogProjection(input);
  const canonicalItemId = await resolveExactMapping(transaction, input, projection);
  await transaction
    .update(canonicalItem)
    .set(projection.item)
    .where(and(eq(canonicalItem.id, canonicalItemId), eq(canonicalItem.kind, input.kind)));
  await replaceExternalIdentifierEvidence(transaction, input);
  await replaceParentEvidence(transaction, input, projection.parentReferences);
  await replaceNestedCatalogRecords(transaction, input, canonicalItemId);
  await refreshSearchProjection(transaction, canonicalItemId);
  const affectedItemIds = await repairHierarchy(transaction, input, canonicalItemId);
  await reconcileLibraryEntries(transaction, affectedItemIds);
  return canonicalItemId;
};

const replaceCanonicalItem = (
  database: CatalogDatabase,
  input: CatalogItemObservation,
): Promise<string> =>
  database.transaction((transaction) => replaceCanonicalItemInTransaction(transaction, input));

export { replaceCanonicalItem, replaceCanonicalItemInTransaction };
