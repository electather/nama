import type {
  CatalogAvailability,
  StoredCatalogMediaSource,
  StoredCatalogMediaTrack,
} from "../database/catalog-persistence-model-private.ts";
import type {
  StoredCatalogAudioQuality,
  StoredCatalogSourceSummary,
  StoredCatalogVideoQuality,
} from "../database/catalog-summary-model-private.ts";

const ABSENT_INDEX = -1;
const ABSENT_VALUE = undefined;
const FIRST_ITEM_INDEX = 0;
const ZERO = 0;

const defaultAudioTrack = (
  source: StoredCatalogMediaSource,
): StoredCatalogMediaTrack | undefined => {
  for (const part of source.parts) {
    for (const track of part.tracks) {
      if (track.details.type === "audio" && track.details.isDefault) {
        return track;
      }
    }
  }
  return ABSENT_VALUE;
};

const firstTrackOfType = (
  source: StoredCatalogMediaSource,
  type: "audio" | "video",
): StoredCatalogMediaTrack | undefined => {
  for (const part of source.parts) {
    for (const track of part.tracks) {
      if (track.details.type === type) {
        return track;
      }
    }
  }
  return ABSENT_VALUE;
};

const firstTrack = (
  source: StoredCatalogMediaSource,
  type: "audio" | "video",
): StoredCatalogMediaTrack | undefined => {
  if (type === "audio") {
    const defaultTrack = defaultAudioTrack(source);
    if (defaultTrack !== undefined) {
      return defaultTrack;
    }
  }
  return firstTrackOfType(source, type);
};

const defaultSourceIndex = (sources: readonly StoredCatalogMediaSource[]): number => {
  const available = sources.findIndex((source) => source.availability === "available");
  if (available !== ABSENT_INDEX) {
    return available;
  }
  const unavailable = sources.findIndex((source) => source.availability === "provider_unavailable");
  if (unavailable !== ABSENT_INDEX) {
    return unavailable;
  }
  if (sources.length === ZERO) {
    return ABSENT_INDEX;
  }
  return FIRST_ITEM_INDEX;
};

const storedAudioQuality = (
  track: StoredCatalogMediaTrack | undefined,
): StoredCatalogAudioQuality | undefined => {
  if (track?.details.type !== "audio") {
    return ABSENT_VALUE;
  }
  const quality: {
    channelCount?: number;
    codec: string;
    spatialFormat?: "dolby_atmos" | "dts_x" | "none";
  } = { codec: track.details.codec };
  if (track.details.channelCount !== undefined) {
    quality.channelCount = track.details.channelCount;
  }
  if (track.details.spatialFormat !== undefined) {
    quality.spatialFormat = track.details.spatialFormat;
  }
  return quality;
};

const storedVideoQuality = (
  track: StoredCatalogMediaTrack | undefined,
): StoredCatalogVideoQuality | undefined => {
  if (track?.details.type !== "video") {
    return ABSENT_VALUE;
  }
  const quality: {
    codec: string;
    dynamicRange?: "dolby_vision" | "hdr10" | "hdr10_plus" | "hlg" | "sdr";
    height?: number;
    width?: number;
  } = { codec: track.details.codec };
  if (track.details.dynamicRange !== undefined) {
    quality.dynamicRange = track.details.dynamicRange;
  }
  if (track.details.height !== undefined) {
    quality.height = track.details.height;
  }
  if (track.details.width !== undefined) {
    quality.width = track.details.width;
  }
  return quality;
};

interface MutableSourceSummary {
  audioQuality?: StoredCatalogAudioQuality;
  availability: CatalogAvailability;
  container?: string;
  id: string;
  isDefault: boolean;
  label?: string;
  videoQuality?: StoredCatalogVideoQuality;
}

const addSourceQuality = (
  summary: MutableSourceSummary,
  source: StoredCatalogMediaSource,
): void => {
  const audioQuality = storedAudioQuality(firstTrack(source, "audio"));
  const videoQuality = storedVideoQuality(firstTrack(source, "video"));
  if (audioQuality !== undefined) {
    summary.audioQuality = audioQuality;
  }
  if (videoQuality !== undefined) {
    summary.videoQuality = videoQuality;
  }
};

const addSourceMetadata = (
  summary: MutableSourceSummary,
  source: StoredCatalogMediaSource,
): void => {
  const container = source.parts[FIRST_ITEM_INDEX]?.container;
  if (container !== undefined) {
    summary.container = container;
  }
  if (source.label !== undefined) {
    summary.label = source.label;
  }
};

const storedSourceSummary = (
  source: StoredCatalogMediaSource,
  index: number,
  selectedIndex: number,
): StoredCatalogSourceSummary => {
  const summary: MutableSourceSummary = {
    availability: source.availability,
    id: source.id,
    isDefault: index === selectedIndex,
  };
  addSourceMetadata(summary, source);
  addSourceQuality(summary, source);
  return summary;
};

const sourceSummaries = (
  sources: readonly StoredCatalogMediaSource[],
): readonly StoredCatalogSourceSummary[] => {
  const selectedIndex = defaultSourceIndex(sources);
  return sources.map((source, index) => storedSourceSummary(source, index, selectedIndex));
};

export { sourceSummaries };
