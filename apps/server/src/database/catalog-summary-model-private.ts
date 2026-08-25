import type {
  CatalogArtworkRole,
  CatalogArtworkTextPresence,
  CatalogAvailability,
  CatalogDynamicRange,
  CatalogMediaKind,
  CatalogSpatialAudioFormat,
  StoredCatalogArtwork,
} from "./catalog-persistence-model-private.ts";

interface StoredCatalogVideoQuality {
  readonly codec: string;
  readonly dynamicRange?: CatalogDynamicRange;
  readonly height?: number;
  readonly width?: number;
}

interface StoredCatalogAudioQuality {
  readonly channelCount?: number;
  readonly codec: string;
  readonly spatialFormat?: CatalogSpatialAudioFormat;
}

interface StoredCatalogSourceSummary {
  readonly audioQuality?: StoredCatalogAudioQuality;
  readonly availability: CatalogAvailability;
  readonly container?: string;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label?: string;
  readonly videoQuality?: StoredCatalogVideoQuality;
}

interface StoredCatalogSummary {
  readonly artwork: readonly StoredCatalogArtwork[];
  readonly contentRating: string | null;
  readonly episodeNumber: number | null;
  readonly genres: readonly string[];
  readonly id: string;
  readonly kind: CatalogMediaKind;
  readonly libraryCreatedAt: Date;
  readonly normalizedTitle: string;
  readonly releaseDateSort: string | null;
  readonly releaseYear: number | null;
  readonly runtimeNanoseconds: number;
  readonly runtimeSeconds: bigint;
  readonly seasonNumber: number | null;
  readonly sources: readonly StoredCatalogSourceSummary[];
  readonly title: string;
}

interface StoredArtworkJson {
  readonly height: number | null;
  readonly id: string;
  readonly locale: string | null;
  readonly role: CatalogArtworkRole;
  readonly textPresence: CatalogArtworkTextPresence;
  readonly width: number | null;
}

interface StoredVideoQualityJson {
  readonly codec: string;
  readonly dynamicRange: CatalogDynamicRange | null;
  readonly height: number | null;
  readonly width: number | null;
}

interface StoredAudioQualityJson {
  readonly channelCount: number | null;
  readonly codec: string;
  readonly spatialFormat: CatalogSpatialAudioFormat | null;
}

interface StoredSourceJson {
  readonly audioQuality: StoredAudioQualityJson | null;
  readonly availability: CatalogAvailability;
  readonly container: string | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label: string | null;
  readonly videoQuality: StoredVideoQualityJson | null;
}

interface StoredSummaryRow extends Omit<StoredCatalogSummary, "artwork" | "kind" | "sources"> {
  readonly artwork: readonly StoredArtworkJson[];
  readonly kind: string;
  readonly sources: readonly StoredSourceJson[];
}

export type {
  StoredArtworkJson,
  StoredAudioQualityJson,
  StoredCatalogAudioQuality,
  StoredCatalogSourceSummary,
  StoredCatalogSummary,
  StoredCatalogVideoQuality,
  StoredSourceJson,
  StoredSummaryRow,
  StoredVideoQualityJson,
};
