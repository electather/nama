import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { insertBatches } from "./catalog-batches-private.ts";
import type {
  CatalogItemObservation,
  CatalogMediaPartObservation,
  CatalogMediaSourceObservation,
  CatalogMediaTrackObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { providerPartMapping } from "./catalog-source-schema.ts";
import { providerTrackMapping } from "./catalog-track-schema.ts";

const EMPTY_LENGTH = 0;

const partIdentityKey = (sourceReference: string, partReference: string): string =>
  `${sourceReference}\u0000${partReference}`;
const trackIdentityKey = (
  sourceReference: string,
  partReference: string,
  trackReference: string,
): string => `${sourceReference}\u0000${partReference}\u0000${trackReference}`;

interface PartWithOwner {
  readonly observation: CatalogMediaPartObservation;
  readonly sourceId: string;
  readonly sourceReference: string;
}

const collectParts = (
  sources: readonly CatalogMediaSourceObservation[],
  sourceIds: ReadonlyMap<string, string>,
): readonly PartWithOwner[] => {
  const parts: PartWithOwner[] = [];
  for (const source of sources) {
    const sourceId = sourceIds.get(source.sourceReference);
    if (sourceId === undefined) {
      throw new Error("provider source identity mapping is missing");
    }
    for (const observation of source.parts) {
      parts.push({ observation, sourceId, sourceReference: source.sourceReference });
    }
  }
  return parts;
};

const upsertPartMappings = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  parts: readonly PartWithOwner[],
): Promise<ReadonlyMap<string, string>> => {
  const candidates = parts.map((part) => ({
    itemReference: input.itemReference,
    partId: randomUUID(),
    partReference: part.observation.partReference,
    providerInstanceId: input.providerInstanceId,
    sourceId: part.sourceId,
    sourceReference: part.sourceReference,
  }));
  await insertBatches(candidates, (batch) =>
    transaction.insert(providerPartMapping).values(batch).onConflictDoNothing(),
  );
  if (parts.length === EMPTY_LENGTH) {
    return new Map();
  }
  const sourceReferences = parts.map((part) => part.sourceReference);
  const partReferences = parts.map((part) => part.observation.partReference);
  const rows = await transaction
    .select({
      partId: providerPartMapping.partId,
      partReference: providerPartMapping.partReference,
      sourceReference: providerPartMapping.sourceReference,
    })
    .from(providerPartMapping)
    .where(
      and(
        eq(providerPartMapping.providerInstanceId, input.providerInstanceId),
        eq(providerPartMapping.itemReference, input.itemReference),
        inArray(providerPartMapping.sourceReference, sourceReferences),
        inArray(providerPartMapping.partReference, partReferences),
      ),
    );
  return new Map(
    rows.map((row) => [partIdentityKey(row.sourceReference, row.partReference), row.partId]),
  );
};

interface TrackWithOwner {
  readonly observation: CatalogMediaTrackObservation;
  readonly partId: string;
  readonly partReference: string;
  readonly sourceReference: string;
}

const collectTracks = (
  parts: readonly PartWithOwner[],
  partIds: ReadonlyMap<string, string>,
): readonly TrackWithOwner[] => {
  const tracks: TrackWithOwner[] = [];
  for (const part of parts) {
    const partId = partIds.get(
      partIdentityKey(part.sourceReference, part.observation.partReference),
    );
    if (partId === undefined) {
      throw new Error("provider part identity mapping is missing");
    }
    for (const observation of part.observation.tracks) {
      tracks.push({
        observation,
        partId,
        partReference: part.observation.partReference,
        sourceReference: part.sourceReference,
      });
    }
  }
  return tracks;
};

const insertTrackMappingCandidates = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  tracks: readonly TrackWithOwner[],
): Promise<void> => {
  const candidates = tracks.map((track) => ({
    itemReference: input.itemReference,
    partId: track.partId,
    partReference: track.partReference,
    providerInstanceId: input.providerInstanceId,
    sourceReference: track.sourceReference,
    trackId: randomUUID(),
    trackReference: track.observation.trackReference,
  }));
  await insertBatches(candidates, (batch) =>
    transaction.insert(providerTrackMapping).values(batch).onConflictDoNothing(),
  );
};

const upsertTrackMappings = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  tracks: readonly TrackWithOwner[],
): Promise<ReadonlyMap<string, string>> => {
  await insertTrackMappingCandidates(transaction, input, tracks);
  if (tracks.length === EMPTY_LENGTH) {
    return new Map();
  }
  const sourceReferences = tracks.map((track) => track.sourceReference);
  const partReferences = tracks.map((track) => track.partReference);
  const trackReferences = tracks.map((track) => track.observation.trackReference);
  const rows = await transaction
    .select({
      partReference: providerTrackMapping.partReference,
      sourceReference: providerTrackMapping.sourceReference,
      trackId: providerTrackMapping.trackId,
      trackReference: providerTrackMapping.trackReference,
    })
    .from(providerTrackMapping)
    .where(
      and(
        eq(providerTrackMapping.providerInstanceId, input.providerInstanceId),
        eq(providerTrackMapping.itemReference, input.itemReference),
        inArray(providerTrackMapping.sourceReference, sourceReferences),
        inArray(providerTrackMapping.partReference, partReferences),
        inArray(providerTrackMapping.trackReference, trackReferences),
      ),
    );
  return new Map(
    rows.map((row) => [
      trackIdentityKey(row.sourceReference, row.partReference, row.trackReference),
      row.trackId,
    ]),
  );
};
export {
  type PartWithOwner,
  type TrackWithOwner,
  collectParts,
  collectTracks,
  partIdentityKey,
  trackIdentityKey,
  upsertPartMappings,
  upsertTrackMappings,
};
