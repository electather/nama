import { asc, inArray, sql } from "drizzle-orm";

import type {
  CatalogTransaction,
  StoredCatalogMediaPart,
  StoredCatalogMediaTrack,
} from "./catalog-persistence-model-private.ts";
import type { TrackReadRow } from "./catalog-read-model-private.ts";
import { trackDetails } from "./catalog-read-model-private.ts";
import { mediaPart, mediaSource } from "./catalog-source-schema.ts";
import { mediaTrack } from "./catalog-track-schema.ts";

const EMPTY_LENGTH = 0;

type NestedTrackRow = TrackReadRow & Pick<typeof mediaTrack.$inferSelect, "id" | "trackOrder">;
interface NestedPartRow {
  readonly bitRateBps: string | null;
  readonly container: string;
  readonly id: string;
  readonly partOrder: number;
  readonly runtimeNanoseconds: number;
  readonly runtimeSeconds: string;
  readonly sizeBytes: string | null;
  readonly tracks: readonly NestedTrackRow[];
}
type PartsBySource = ReadonlyMap<string, readonly StoredCatalogMediaPart[]>;

const nestedPartsSelection = sql<readonly NestedPartRow[]>`
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'bitRateBps', ${mediaPart.bitRateBps}::text,
        'container', ${mediaPart.container},
        'id', ${mediaPart.id},
        'partOrder', ${mediaPart.partOrder},
        'runtimeNanoseconds', ${mediaPart.runtimeNanoseconds},
        'runtimeSeconds', ${mediaPart.runtimeSeconds}::text,
        'sizeBytes', ${mediaPart.sizeBytes}::text,
        'tracks', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'bitDepth', ${mediaTrack.bitDepth},
              'channelCount', ${mediaTrack.channelCount},
              'channelLayout', ${mediaTrack.channelLayout},
              'codec', ${mediaTrack.codec},
              'dynamicRange', ${mediaTrack.dynamicRange},
              'frameRate', ${mediaTrack.frameRate},
              'height', ${mediaTrack.height},
              'id', ${mediaTrack.id},
              'isCommentary', ${mediaTrack.isCommentary},
              'isDefault', ${mediaTrack.isDefault},
              'isForced', ${mediaTrack.isForced},
              'isHearingImpaired', ${mediaTrack.isHearingImpaired},
              'language', ${mediaTrack.language},
              'representation', ${mediaTrack.representation},
              'sampleRateHz', ${mediaTrack.sampleRateHz},
              'spatialFormat', ${mediaTrack.spatialFormat},
              'title', ${mediaTrack.title},
              'trackOrder', ${mediaTrack.trackOrder},
              'type', ${mediaTrack.type},
              'width', ${mediaTrack.width}
            )
            order by ${mediaTrack.trackOrder}
          )
          from ${mediaTrack}
          where "media_track"."part_id" = "media_part"."id"
        ), '[]'::jsonb)
      )
      order by ${mediaPart.partOrder}
    )
    from ${mediaPart}
    where "media_part"."source_id" = "media_source"."id"
  ), '[]'::jsonb)
`.as("parts");

const storedPart = (part: NestedPartRow): StoredCatalogMediaPart => {
  let bitRateBps: bigint | undefined = undefined;
  if (part.bitRateBps !== null) {
    bitRateBps = BigInt(part.bitRateBps);
  }
  let sizeBytes: bigint | undefined = undefined;
  if (part.sizeBytes !== null) {
    sizeBytes = BigInt(part.sizeBytes);
  }
  return {
    bitRateBps,
    container: part.container,
    id: part.id,
    order: part.partOrder,
    runtime: { nanoseconds: part.runtimeNanoseconds, seconds: BigInt(part.runtimeSeconds) },
    sizeBytes,
    tracks: part.tracks.map((track): StoredCatalogMediaTrack => ({
      details: trackDetails(track),
      id: track.id,
      order: track.trackOrder,
    })),
  };
};

const loadPartsBySource = async (
  database: CatalogTransaction,
  sourceIds: readonly string[],
): Promise<PartsBySource> => {
  if (sourceIds.length === EMPTY_LENGTH) {
    return new Map();
  }
  const nestedRows = await database
    .select({ parts: nestedPartsSelection, sourceId: mediaSource.id })
    .from(mediaSource)
    .where(inArray(mediaSource.id, sourceIds))
    .orderBy(asc(mediaSource.sourceOrder));
  return new Map(
    nestedRows.map((row) => [row.sourceId, row.parts.map((part) => storedPart(part))]),
  );
};

export { type PartsBySource, loadPartsBySource };
