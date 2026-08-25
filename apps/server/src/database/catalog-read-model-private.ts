import type { canonicalArtwork } from "./catalog-artwork-schema.ts";
import type {
  CatalogArtworkRole,
  CatalogArtworkTextPresence,
  CatalogAvailability,
  CatalogCreditRole,
  CatalogDynamicRange,
  CatalogMediaKind,
  CatalogSpatialAudioFormat,
  CatalogSubtitleRepresentation,
  CatalogTrackDetailsObservation,
  StoredCatalogArtwork,
} from "./catalog-persistence-model-private.ts";
import type { mediaTrack } from "./catalog-track-schema.ts";

const mediaKind = (value: string): CatalogMediaKind => {
  switch (value) {
    case "episode":
    case "movie":
    case "season":
    case "show": {
      return value;
    }
    default: {
      throw new Error("stored catalog media kind is invalid");
    }
  }
};

const availability = (value: string): CatalogAvailability => {
  switch (value) {
    case "available":
    case "provider_unavailable":
    case "unsupported": {
      return value;
    }
    default: {
      throw new Error("stored source availability is invalid");
    }
  }
};

const artworkRole = (value: string): CatalogArtworkRole => {
  switch (value) {
    case "backdrop":
    case "logo":
    case "portrait":
    case "poster":
    case "thumbnail": {
      return value;
    }
    default: {
      throw new Error("stored artwork role is invalid");
    }
  }
};

const artworkTextPresence = (value: string): CatalogArtworkTextPresence => {
  switch (value) {
    case "contains_text":
    case "textless":
    case "unknown": {
      return value;
    }
    default: {
      throw new Error("stored artwork text presence is invalid");
    }
  }
};

const creditRole = (value: string): CatalogCreditRole => {
  switch (value) {
    case "actor":
    case "director":
    case "writer": {
      return value;
    }
    default: {
      throw new Error("stored credit role is invalid");
    }
  }
};

const dynamicRange = (value: string | undefined): CatalogDynamicRange | undefined => {
  if (value === undefined) {
    return undefined;
  }
  switch (value) {
    case "dolby_vision":
    case "hdr10":
    case "hdr10_plus":
    case "hlg":
    case "sdr": {
      return value;
    }
    default: {
      throw new Error("stored dynamic range is invalid");
    }
  }
};

const spatialFormat = (value: string | undefined): CatalogSpatialAudioFormat | undefined => {
  if (value === undefined) {
    return undefined;
  }
  switch (value) {
    case "dolby_atmos":
    case "dts_x":
    case "none": {
      return value;
    }
    default: {
      throw new Error("stored spatial audio format is invalid");
    }
  }
};

const subtitleRepresentation = (value: string | undefined): CatalogSubtitleRepresentation => {
  switch (value) {
    case "image":
    case "text": {
      return value;
    }
    case undefined: {
      throw new Error("stored subtitle representation is missing");
    }
    default: {
      throw new Error("stored subtitle representation is invalid");
    }
  }
};

type ArtworkReadRow = Pick<
  typeof canonicalArtwork.$inferSelect,
  "height" | "id" | "locale" | "role" | "textPresence" | "width"
>;
type TrackReadRow = Pick<
  typeof mediaTrack.$inferSelect,
  | "bitDepth"
  | "channelCount"
  | "channelLayout"
  | "codec"
  | "dynamicRange"
  | "frameRate"
  | "height"
  | "isCommentary"
  | "isDefault"
  | "isForced"
  | "isHearingImpaired"
  | "language"
  | "representation"
  | "sampleRateHz"
  | "spatialFormat"
  | "title"
  | "type"
  | "width"
>;

const storedArtwork = (row: ArtworkReadRow): StoredCatalogArtwork => ({
  height: row.height ?? undefined,
  id: row.id,
  locale: row.locale ?? undefined,
  role: artworkRole(row.role),
  textPresence: artworkTextPresence(row.textPresence),
  width: row.width ?? undefined,
});

const trackDetails = (row: TrackReadRow): CatalogTrackDetailsObservation => {
  switch (row.type) {
    case "audio": {
      return {
        channelCount: row.channelCount ?? undefined,
        channelLayout: row.channelLayout ?? undefined,
        codec: row.codec,
        isCommentary: row.isCommentary,
        isDefault: row.isDefault,
        language: row.language ?? undefined,
        sampleRateHz: row.sampleRateHz ?? undefined,
        spatialFormat: spatialFormat(row.spatialFormat ?? undefined),
        title: row.title ?? undefined,
        type: "audio",
      };
    }
    case "subtitle": {
      return {
        codec: row.codec,
        isCommentary: row.isCommentary,
        isDefault: row.isDefault,
        isForced: row.isForced,
        isHearingImpaired: row.isHearingImpaired,
        language: row.language ?? undefined,
        representation: subtitleRepresentation(row.representation ?? undefined),
        title: row.title ?? undefined,
        type: "subtitle",
      };
    }
    case "video": {
      return {
        bitDepth: row.bitDepth ?? undefined,
        codec: row.codec,
        dynamicRange: dynamicRange(row.dynamicRange ?? undefined),
        frameRate: row.frameRate ?? undefined,
        height: row.height ?? undefined,
        type: "video",
        width: row.width ?? undefined,
      };
    }
    default: {
      throw new Error("stored track type is invalid");
    }
  }
};

export {
  type ArtworkReadRow,
  type TrackReadRow,
  availability,
  creditRole,
  mediaKind,
  storedArtwork,
  trackDetails,
};
