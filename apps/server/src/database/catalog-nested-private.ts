import { and, eq } from "drizzle-orm";

import { canonicalArtwork, canonicalCredit } from "./catalog-artwork-schema.ts";
import { insertBatches } from "./catalog-batches-private.ts";
import {
  collectParts,
  collectTracks,
  partIdentityKey,
  trackIdentityKey,
  upsertPartMappings,
  upsertTrackMappings,
} from "./catalog-deep-identities-private.ts";
import type { PartWithOwner, TrackWithOwner } from "./catalog-deep-identities-private.ts";
import {
  collectActiveArtwork,
  artworkIdentityId,
  upsertArtworkMappings,
  upsertSourceMappings,
} from "./catalog-nested-identities-private.ts";
import type {
  ActiveArtwork,
  ArtworkIdsByTargetReference,
} from "./catalog-nested-identities-private.ts";
import type {
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import { mediaPart, mediaSource } from "./catalog-source-schema.ts";
import { mediaTrack } from "./catalog-track-schema.ts";

interface ArtworkProjectionInput {
  readonly artwork: readonly ActiveArtwork[];
  readonly artworkIds: ArtworkIdsByTargetReference;
  readonly canonicalItemId: string;
  readonly input: CatalogItemObservation;
  readonly transaction: CatalogTransaction;
}

const insertActiveArtworkAndCredits = async ({
  artwork,
  artworkIds,
  canonicalItemId,
  input,
  transaction,
}: ArtworkProjectionInput): Promise<void> => {
  const artworkRows = artwork.map((entry) => {
    const id = artworkIdentityId(
      {
        artworkReference: entry.artworkReference,
        itemReference: entry.targetItemReference,
      },
      artworkIds,
    );
    if (id === undefined) {
      throw new Error("provider artwork identity mapping is missing");
    }
    return {
      artworkReference: entry.artworkReference,
      canonicalItemId,
      displayOrder: entry.displayOrder,
      height: entry.height,
      id,
      itemReference: input.itemReference,
      locale: entry.locale,
      providerInstanceId: input.providerInstanceId,
      role: entry.role,
      textPresence: entry.textPresence,
      targetItemReference: entry.targetItemReference,
      width: entry.width,
    };
  });
  await insertBatches(artworkRows, (batch) => transaction.insert(canonicalArtwork).values(batch));

  const creditRows = input.credits.map((credit, displayOrder) => {
    const portraitId =
      credit.portraitArtworkReference === undefined
        ? undefined
        : artworkIdentityId(credit.portraitArtworkReference, artworkIds);
    return {
      canonicalItemId,
      characterName: credit.characterName,
      displayOrder,
      name: credit.name,
      portraitArtworkId: portraitId,
      role: credit.role,
    };
  });
  await insertBatches(creditRows, (batch) => transaction.insert(canonicalCredit).values(batch));
};

interface SourceProjectionInput {
  readonly canonicalItemId: string;
  readonly input: CatalogItemObservation;
  readonly sourceIds: ReadonlyMap<string, string>;
  readonly transaction: CatalogTransaction;
}

const insertActiveSources = async ({
  canonicalItemId,
  input,
  sourceIds,
  transaction,
}: SourceProjectionInput): Promise<void> => {
  const rows = input.sources.map((source, sourceOrder) => {
    const id = sourceIds.get(source.sourceReference);
    if (id === undefined) {
      throw new Error("provider source identity mapping is missing");
    }
    return {
      availability: source.availability,
      bitRateBps: source.bitRateBps,
      canonicalItemId,
      id,
      itemReference: input.itemReference,
      label: source.label,
      providerInstanceId: input.providerInstanceId,
      runtimeNanoseconds: source.runtime.nanoseconds,
      runtimeSeconds: source.runtime.seconds,
      sourceOrder,
      sourceReference: source.sourceReference,
    };
  });
  await insertBatches(rows, (batch) => transaction.insert(mediaSource).values(batch));
};

const insertActiveParts = async (
  transaction: CatalogTransaction,
  parts: readonly PartWithOwner[],
  partIds: ReadonlyMap<string, string>,
): Promise<void> => {
  const rows = parts.map((part) => {
    const id = partIds.get(partIdentityKey(part.sourceReference, part.observation.partReference));
    if (id === undefined) {
      throw new Error("provider part identity mapping is missing");
    }
    return {
      bitRateBps: part.observation.bitRateBps,
      container: part.observation.container,
      id,
      partOrder: part.observation.order,
      runtimeNanoseconds: part.observation.runtime.nanoseconds,
      runtimeSeconds: part.observation.runtime.seconds,
      sizeBytes: part.observation.sizeBytes,
      sourceId: part.sourceId,
    };
  });
  await insertBatches(rows, (batch) => transaction.insert(mediaPart).values(batch));
};

const trackRow = (track: TrackWithOwner, id: string): typeof mediaTrack.$inferInsert => {
  const common = {
    codec: track.observation.details.codec,
    id,
    partId: track.partId,
    trackOrder: track.observation.order,
    type: track.observation.details.type,
  };
  switch (track.observation.details.type) {
    case "audio": {
      return {
        ...common,
        channelCount: track.observation.details.channelCount,
        channelLayout: track.observation.details.channelLayout,
        isCommentary: track.observation.details.isCommentary,
        isDefault: track.observation.details.isDefault,
        language: track.observation.details.language,
        sampleRateHz: track.observation.details.sampleRateHz,
        spatialFormat: track.observation.details.spatialFormat,
        title: track.observation.details.title,
      };
    }
    case "subtitle": {
      return {
        ...common,
        isCommentary: track.observation.details.isCommentary,
        isDefault: track.observation.details.isDefault,
        isForced: track.observation.details.isForced,
        isHearingImpaired: track.observation.details.isHearingImpaired,
        language: track.observation.details.language,
        representation: track.observation.details.representation,
        title: track.observation.details.title,
      };
    }
    case "video": {
      return {
        ...common,
        bitDepth: track.observation.details.bitDepth,
        dynamicRange: track.observation.details.dynamicRange,
        frameRate: track.observation.details.frameRate,
        height: track.observation.details.height,
        width: track.observation.details.width,
      };
    }
    default: {
      throw new Error("catalog track observation type is invalid");
    }
  }
};

const insertActiveTracks = async (
  transaction: CatalogTransaction,
  tracks: readonly TrackWithOwner[],
  trackIds: ReadonlyMap<string, string>,
): Promise<void> => {
  const rows = tracks.map((track) => {
    const key = trackIdentityKey(
      track.sourceReference,
      track.partReference,
      track.observation.trackReference,
    );
    const id = trackIds.get(key);
    if (id === undefined) {
      throw new Error("provider track identity mapping is missing");
    }
    return trackRow(track, id);
  });
  await insertBatches(rows, (batch) => transaction.insert(mediaTrack).values(batch));
};

const clearActiveNestedProjection = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  canonicalItemId: string,
): Promise<void> => {
  const creditDeletion = transaction
    .delete(canonicalCredit)
    .where(eq(canonicalCredit.canonicalItemId, canonicalItemId));
  const artworkDeletion = transaction
    .delete(canonicalArtwork)
    .where(
      and(
        eq(canonicalArtwork.providerInstanceId, input.providerInstanceId),
        eq(canonicalArtwork.itemReference, input.itemReference),
      ),
    );
  const sourceDeletion = transaction
    .delete(mediaSource)
    .where(
      and(
        eq(mediaSource.providerInstanceId, input.providerInstanceId),
        eq(mediaSource.itemReference, input.itemReference),
      ),
    );
  await creditDeletion;
  await artworkDeletion;
  await sourceDeletion;
};

interface NestedIdentityState {
  readonly artwork: readonly ActiveArtwork[];
  readonly artworkIds: ArtworkIdsByTargetReference;
  readonly partIds: ReadonlyMap<string, string>;
  readonly parts: readonly PartWithOwner[];
  readonly sourceIds: ReadonlyMap<string, string>;
  readonly trackIds: ReadonlyMap<string, string>;
  readonly tracks: readonly TrackWithOwner[];
}

const resolveNestedIdentityState = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  canonicalItemId: string,
): Promise<NestedIdentityState> => {
  const artwork = collectActiveArtwork(input);
  const artworkIds = await upsertArtworkMappings({
    artwork,
    canonicalItemId,
    input,
    transaction,
  });
  const sourceIds = await upsertSourceMappings(transaction, input, canonicalItemId);
  const parts = collectParts(input.sources, sourceIds);
  const partIds = await upsertPartMappings(transaction, input, parts);
  const tracks = collectTracks(parts, partIds);
  const trackIds = await upsertTrackMappings(transaction, input, tracks);
  return { artwork, artworkIds, partIds, parts, sourceIds, trackIds, tracks };
};

const replaceNestedCatalogRecords = async (
  transaction: CatalogTransaction,
  input: CatalogItemObservation,
  canonicalItemId: string,
): Promise<void> => {
  const state = await resolveNestedIdentityState(transaction, input, canonicalItemId);
  await clearActiveNestedProjection(transaction, input, canonicalItemId);
  await insertActiveArtworkAndCredits({
    artwork: state.artwork,
    artworkIds: state.artworkIds,
    canonicalItemId,
    input,
    transaction,
  });
  await insertActiveSources({
    canonicalItemId,
    input,
    sourceIds: state.sourceIds,
    transaction,
  });
  await insertActiveParts(transaction, state.parts, state.partIds);
  await insertActiveTracks(transaction, state.tracks, state.trackIds);
};

export { replaceNestedCatalogRecords };
