import type {
  CatalogAvailability,
  CatalogDynamicRange,
  CatalogSpatialAudioFormat,
} from "./catalog-persistence-model-private.ts";
import { mediaKind } from "./catalog-read-model-private.ts";
import type {
  StoredAudioQualityJson,
  StoredCatalogAudioQuality,
  StoredCatalogSourceSummary,
  StoredCatalogSummary,
  StoredCatalogVideoQuality,
  StoredSourceJson,
  StoredSummaryRow,
  StoredVideoQualityJson,
} from "./catalog-summary-model-private.ts";

const ABSENT_VALUE = undefined;
interface MutableStoredSource {
  audioQuality?: StoredCatalogAudioQuality;
  availability: CatalogAvailability;
  container?: string;
  id: string;
  isDefault: boolean;
  label?: string;
  videoQuality?: StoredCatalogVideoQuality;
}

const storedAudioQuality = (
  quality: StoredAudioQualityJson | null,
): StoredCatalogAudioQuality | undefined => {
  if (quality === null) {
    return ABSENT_VALUE;
  }
  const stored: {
    channelCount?: number;
    codec: string;
    spatialFormat?: CatalogSpatialAudioFormat;
  } = { codec: quality.codec };
  if (quality.channelCount !== null) {
    stored.channelCount = quality.channelCount;
  }
  if (quality.spatialFormat !== null) {
    stored.spatialFormat = quality.spatialFormat;
  }
  return stored;
};

const storedVideoQuality = (
  quality: StoredVideoQualityJson | null,
): StoredCatalogVideoQuality | undefined => {
  if (quality === null) {
    return ABSENT_VALUE;
  }
  const stored: {
    codec: string;
    dynamicRange?: CatalogDynamicRange;
    height?: number;
    width?: number;
  } = { codec: quality.codec };
  if (quality.dynamicRange !== null) {
    stored.dynamicRange = quality.dynamicRange;
  }
  if (quality.height !== null) {
    stored.height = quality.height;
  }
  if (quality.width !== null) {
    stored.width = quality.width;
  }
  return stored;
};

const addStoredQuality = (stored: MutableStoredSource, source: StoredSourceJson): void => {
  const audioQuality = storedAudioQuality(source.audioQuality);
  const videoQuality = storedVideoQuality(source.videoQuality);
  if (audioQuality !== undefined) {
    stored.audioQuality = audioQuality;
  }
  if (videoQuality !== undefined) {
    stored.videoQuality = videoQuality;
  }
};

const addStoredMetadata = (stored: MutableStoredSource, source: StoredSourceJson): void => {
  if (source.container !== null) {
    stored.container = source.container;
  }
  if (source.label !== null) {
    stored.label = source.label;
  }
};

const storedSource = (source: StoredSourceJson): StoredCatalogSourceSummary => {
  const stored: MutableStoredSource = {
    availability: source.availability,
    id: source.id,
    isDefault: source.isDefault,
  };
  addStoredQuality(stored, source);
  addStoredMetadata(stored, source);
  return stored;
};

const storedSummary = (row: StoredSummaryRow): StoredCatalogSummary => ({
  ...row,
  artwork: row.artwork.map((artwork) => ({
    height: artwork.height ?? undefined,
    id: artwork.id,
    locale: artwork.locale ?? undefined,
    role: artwork.role,
    textPresence: artwork.textPresence,
    width: artwork.width ?? undefined,
  })),
  kind: mediaKind(row.kind),
  sources: row.sources.map((source) => storedSource(source)),
});

export { storedSummary };
