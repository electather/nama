import { Effect } from "effect";
import type { Pool } from "pg";

import type {
  CatalogDuration,
  CatalogItemObservation,
  CatalogMediaSourceObservation,
} from "../../src/database/catalog-persistence.ts";
import { insertFixtureUser } from "./database-constraint.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";

const ADMINISTRATOR_ID = "catalog-administrator";
const PROVIDER_TYPE_ID = "catalog-test-provider";
const PROVIDER_PAYLOAD_SENTINEL = "provider-payload-sentinel";
const ITEM_REFERENCE = `private-item-${PROVIDER_PAYLOAD_SENTINEL}`;
const SOURCE_REFERENCE = `private-source-${PROVIDER_PAYLOAD_SENTINEL}`;
const SECOND_SOURCE_REFERENCE = "private-source-secondary";
const PART_REFERENCE = `private-part-${PROVIDER_PAYLOAD_SENTINEL}`;
const TRACK_REFERENCE = `private-track-${PROVIDER_PAYLOAD_SENTINEL}`;
const ARTWORK_REFERENCE = `private-artwork-${PROVIDER_PAYLOAD_SENTINEL}`;
const EXTERNAL_IDENTIFIER_SENTINEL = `private-external-${PROVIDER_PAYLOAD_SENTINEL}`;
const PROVIDER_DIGEST_BYTES = 32;
const ZERO_DURATION: CatalogDuration = Object.freeze({ nanoseconds: 0, seconds: 0n });

interface ProviderFixture {
  readonly enabled?: boolean;
  readonly id: string;
  readonly priority: number;
}

const seedProviders = (databaseUrl: string, fixtures: readonly ProviderFixture[]) =>
  withPool(databaseUrl, (pool) =>
    Effect.gen(function* seedProviderFixtures() {
      yield* Effect.promise(() =>
        pool.query(
          `INSERT INTO provider_installation (
             provider_type_id, capabilities, configuration_schema, contract_major,
             description, display_name, plugin_build_version, schema_profile_version,
             schema_revision
           ) VALUES ($1, '[]'::jsonb, '{"properties": {}}'::jsonb, 1, '', $2, 'test', 1, 'test')
           ON CONFLICT (provider_type_id) DO NOTHING`,
          [PROVIDER_TYPE_ID, "Catalog test provider"],
        ),
      );
      const insertions = fixtures.map((fixture) =>
        Effect.promise(() =>
          pool.query(
            `INSERT INTO provider_instance (
               configuration, display_name, enabled, id, principal_digest,
               provider_type_id, revision, sync_priority
             ) VALUES ('{}'::jsonb, $1, $2, $3, $4, $5, $6, $7)`,
            [
              fixture.id,
              fixture.enabled ?? true,
              fixture.id,
              Buffer.alloc(PROVIDER_DIGEST_BYTES, fixture.priority),
              PROVIDER_TYPE_ID,
              `${fixture.id}-revision`,
              fixture.priority,
            ],
          ),
        ),
      );
      yield* Effect.all(insertions);
    }),
  );

const initializeCatalogDatabase = (
  databaseUrl: string,
  providers: readonly {
    readonly enabled?: boolean;
    readonly id: string;
    readonly priority: number;
  }[],
  includeAdministrator = false,
) =>
  Effect.gen(function* initializeCatalogDatabaseFixture() {
    yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
    yield* seedProviders(databaseUrl, providers);
    if (includeAdministrator) {
      yield* withPool(databaseUrl, (pool) =>
        insertFixtureUser(pool, ADMINISTRATOR_ID, "catalog-administrator@example.test"),
      );
    }
  });

const videoSource = (
  sourceReference = SOURCE_REFERENCE,
  partReference = PART_REFERENCE,
  trackReference = TRACK_REFERENCE,
): CatalogMediaSourceObservation => ({
  availability: "available",
  bitRateBps: 8_000_000n,
  label: "Primary",
  parts: [
    {
      bitRateBps: 8_000_000n,
      container: "mkv",
      order: 0,
      partReference,
      runtime: { nanoseconds: 0, seconds: 7200n },
      sizeBytes: 7_200_000_000n,
      tracks: [
        {
          details: {
            bitDepth: 10,
            codec: "hevc",
            dynamicRange: "hdr10",
            frameRate: 24,
            height: 2160,
            type: "video",
            width: 3840,
          },
          order: 0,
          trackReference,
        },
      ],
    },
  ],
  runtime: { nanoseconds: 0, seconds: 7200n },
  sourceReference,
});

const audioSource = (): CatalogMediaSourceObservation => ({
  availability: "available",
  label: "Commentary",
  parts: [
    {
      container: "mka",
      order: 0,
      partReference: "private-part-secondary",
      runtime: ZERO_DURATION,
      tracks: [
        {
          details: {
            channelCount: 2,
            codec: "aac",
            isCommentary: true,
            isDefault: false,
            language: "en",
            spatialFormat: "none",
            type: "audio",
          },
          order: 0,
          trackReference: "private-track-secondary",
        },
      ],
    },
  ],
  runtime: ZERO_DURATION,
  sourceReference: SECOND_SOURCE_REFERENCE,
});

const movieObservation = (
  providerInstanceId: string,
  overrides: Partial<CatalogItemObservation & { readonly kind: "movie" }> = {},
): CatalogItemObservation => ({
  artwork: [
    {
      artworkReference: ARTWORK_REFERENCE,
      height: 1500,
      locale: "en-US",
      role: "poster",
      textPresence: "contains_text",
      width: 1000,
    },
  ],
  contentRating: "PG-13",
  credits: [
    {
      characterName: "Ada",
      name: "Example Actor",
      portraitArtworkReference: "private-credit-portrait",
      role: "actor",
    },
  ],
  externalIdentifiers: [{ namespace: "  IMDB  ", value: `  ${EXTERNAL_IDENTIFIER_SENTINEL}  ` }],
  genres: ["Drama", "Science Fiction"],
  itemReference: ITEM_REFERENCE,
  kind: "movie",
  originalTitle: "Original catalog title",
  providerInstanceId,
  releaseDate: "2026-08-23",
  releaseYear: 2026,
  runtime: { nanoseconds: 0, seconds: 7200n },
  sources: [videoSource(), audioSource()],
  studios: ["Nama Pictures"],
  synopsis: "A complete canonical aggregate.",
  tagline: "Stored without provider payloads.",
  title: "Catalog Movie",
  ...overrides,
});

const showObservation = (providerInstanceId: string): CatalogItemObservation => ({
  artwork: [],
  credits: [],
  episodeCount: 10,
  externalIdentifiers: [],
  firstReleaseDate: "2025-01-01",
  genres: ["Drama"],
  itemReference: "private-show-reference",
  kind: "show",
  lastReleaseDate: "2025-03-01",
  providerInstanceId,
  runtime: ZERO_DURATION,
  seasonCount: 1,
  sources: [videoSource("private-show-source", "private-show-part", "private-show-track")],
  studios: [],
  title: "Catalog Show",
});

const seasonObservation = (providerInstanceId: string): CatalogItemObservation => ({
  artwork: [],
  credits: [],
  episodeCount: 10,
  externalIdentifiers: [],
  genres: [],
  itemReference: "private-season-reference",
  kind: "season",
  providerInstanceId,
  runtime: ZERO_DURATION,
  seasonNumber: 1,
  showReference: "private-show-reference",
  sources: [videoSource("private-season-source", "private-season-part", "private-season-track")],
  studios: [],
  title: "Season One",
});

const episodeObservation = (providerInstanceId: string): CatalogItemObservation => ({
  artwork: [],
  credits: [],
  episodeNumber: 2,
  externalIdentifiers: [],
  genres: [],
  itemReference: "private-episode-reference",
  kind: "episode",
  providerInstanceId,
  releaseDate: "2025-01-08",
  runtime: { nanoseconds: 0, seconds: 3600n },
  seasonNumber: 1,
  seasonReference: "private-season-reference",
  showReference: "private-show-reference",
  sources: [videoSource("private-episode-source", "private-episode-part", "private-episode-track")],
  studios: [],
  title: "Episode Two",
});

const retargetProviderMapping = (pool: Pool, providerInstanceId: string, canonicalItemId: string) =>
  Effect.promise(() =>
    pool.query(
      "UPDATE provider_item_mapping SET canonical_item_id = $1 WHERE provider_instance_id = $2",
      [canonicalItemId, providerInstanceId],
    ),
  );

export {
  ADMINISTRATOR_ID,
  EXTERNAL_IDENTIFIER_SENTINEL,
  PROVIDER_PAYLOAD_SENTINEL,
  audioSource,
  episodeObservation,
  initializeCatalogDatabase,
  movieObservation,
  retargetProviderMapping,
  seasonObservation,
  showObservation,
  videoSource,
};
