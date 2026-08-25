// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/prefer-destructuring -- The literal full plugin aggregate and independently derived canonical expectation remain side by side as one protocol fixture.
import { create } from "@bufbuild/protobuf";
import { DateSchema } from "@nama/api/google/type/date_pb.js";
import {
  ProviderArtworkReferenceSchema,
  ProviderItemReferenceSchema,
  ProviderPartReferenceSchema,
  ProviderSourceReferenceSchema,
  ProviderTrackReferenceSchema,
} from "@nama/api/nama/plugin/v1/common_pb.js";
import { ListConsistency, ListItemsResponseSchema } from "@nama/api/nama/plugin/v1/library_pb.js";
import {
  ArtworkRole,
  ArtworkTextPresence,
  DynamicRange,
  MediaCreditRole,
  MediaKind,
  ProviderMediaItemSchema,
  SourceAvailability,
} from "@nama/api/nama/plugin/v1/media_pb.js";
import { describe, expect, it } from "vitest";

import { catalogPageFromPlugin } from "../catalog-item-mapper.ts";

const PROVIDER_INSTANCE_ID = "provider-instance";
const CORE_RUN_ID = "core-run";
const ITEM_REFERENCE = "private-item";

const itemReference = (itemId = ITEM_REFERENCE) => create(ProviderItemReferenceSchema, { itemId });

const sourceReference = (itemId = ITEM_REFERENCE, sourceId = "private-source") =>
  create(ProviderSourceReferenceSchema, {
    itemReference: itemReference(itemId),
    sourceId,
  });

const partReference = (itemId = ITEM_REFERENCE) =>
  create(ProviderPartReferenceSchema, {
    partId: "private-part",
    sourceReference: sourceReference(itemId),
  });

const fullMovie = () =>
  create(ProviderMediaItemSchema, {
    artwork: [
      {
        artworkReference: create(ProviderArtworkReferenceSchema, {
          artworkId: "private-artwork",
          itemReference: itemReference(),
        }),
        height: 1500,
        locale: "en-US",
        role: ArtworkRole.POSTER,
        textPresence: ArtworkTextPresence.CONTAINS_TEXT,
        width: 1000,
      },
    ],
    contentRating: "PG-13",
    credits: [
      {
        characterName: "Ada",
        name: "Example Actor",
        portraitArtworkReference: create(ProviderArtworkReferenceSchema, {
          artworkId: "private-portrait",
          itemReference: itemReference("private-person"),
        }),
        role: MediaCreditRole.ACTOR,
      },
    ],
    externalIdentifiers: [{ namespace: "imdb", value: "tt123" }],
    genres: ["Drama"],
    itemReference: itemReference(),
    kind: MediaKind.MOVIE,
    kindDetails: {
      case: "movie",
      value: { releaseDate: { day: 25, month: 8, year: 2026 } },
    },
    originalTitle: "Original title",
    releaseYear: 2026,
    runtime: { nanos: 7, seconds: 7200n },
    sources: [
      {
        availability: SourceAvailability.AVAILABLE,
        bitRateBps: 8_000_000n,
        label: "Primary",
        parts: [
          {
            bitRateBps: 8_000_000n,
            container: "mkv",
            order: 0,
            partReference: partReference(),
            runtime: { nanos: 5, seconds: 7200n },
            sizeBytes: 7_200_000_000n,
            tracks: [
              {
                details: {
                  case: "video",
                  value: {
                    bitDepth: 10,
                    codec: "hevc",
                    dynamicRange: DynamicRange.HDR10,
                    frameRate: 24,
                    height: 2160,
                    width: 3840,
                  },
                },
                order: 0,
                trackReference: create(ProviderTrackReferenceSchema, {
                  partReference: partReference(),
                  trackId: "private-track",
                }),
              },
            ],
          },
        ],
        runtime: { nanos: 7, seconds: 7200n },
        sourceReference: sourceReference(),
      },
    ],
    studios: ["Nama Pictures"],
    synopsis: "A complete provider-neutral observation.",
    tagline: "Mapped once.",
    title: "Catalog Movie",
  });

describe("catalogPageFromPlugin", () => {
  it("maps one complete plugin movie aggregate into canonical persistence input", () => {
    const page = catalogPageFromPlugin(
      PROVIDER_INSTANCE_ID,
      CORE_RUN_ID,
      create(ListItemsResponseSchema, {
        complete: false,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [fullMovie()],
        nextPageToken: "next-page",
      }),
    );

    expect(page).toEqual({
      complete: false,
      items: [
        {
          artwork: [
            {
              artworkReference: "private-artwork",
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
              portraitArtworkReference: {
                artworkReference: "private-portrait",
                itemReference: "private-person",
              },
              role: "actor",
            },
          ],
          externalIdentifiers: [{ namespace: "imdb", value: "tt123" }],
          genres: ["Drama"],
          itemReference: ITEM_REFERENCE,
          kind: "movie",
          lastSeenScanRunId: CORE_RUN_ID,
          originalTitle: "Original title",
          providerInstanceId: PROVIDER_INSTANCE_ID,
          releaseDate: "2026-08-25",
          releaseYear: 2026,
          runtime: { nanoseconds: 7, seconds: 7200n },
          sources: [
            {
              availability: "available",
              bitRateBps: 8_000_000n,
              label: "Primary",
              parts: [
                {
                  bitRateBps: 8_000_000n,
                  container: "mkv",
                  order: 0,
                  partReference: "private-part",
                  runtime: { nanoseconds: 5, seconds: 7200n },
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
                      trackReference: "private-track",
                    },
                  ],
                },
              ],
              runtime: { nanoseconds: 7, seconds: 7200n },
              sourceReference: "private-source",
            },
          ],
          studios: ["Nama Pictures"],
          synopsis: "A complete provider-neutral observation.",
          tagline: "Mapped once.",
          title: "Catalog Movie",
        },
      ],
      nextContinuation: "next-page",
    });
  });

  it("maps out-of-order season and episode parent references without placeholders", () => {
    const season = create(ProviderMediaItemSchema, {
      itemReference: itemReference("season"),
      kind: MediaKind.SEASON,
      kindDetails: {
        case: "season",
        value: {
          episodeCount: 2,
          seasonNumber: 1,
          showReference: itemReference("show"),
        },
      },
      title: "Season One",
    });
    const episode = create(ProviderMediaItemSchema, {
      itemReference: itemReference("episode"),
      kind: MediaKind.EPISODE,
      kindDetails: {
        case: "episode",
        value: {
          episodeNumber: 2,
          seasonNumber: 1,
          seasonReference: itemReference("season"),
          showReference: itemReference("show"),
        },
      },
      runtime: { nanos: 0, seconds: 1800n },
      title: "Episode Two",
    });

    const page = catalogPageFromPlugin(
      PROVIDER_INSTANCE_ID,
      CORE_RUN_ID,
      create(ListItemsResponseSchema, {
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [episode, season],
      }),
    );

    expect(page.items).toMatchObject([
      {
        episodeNumber: 2,
        itemReference: "episode",
        kind: "episode",
        seasonNumber: 1,
        seasonReference: "season",
        showReference: "show",
      },
      {
        episodeCount: 2,
        itemReference: "season",
        kind: "season",
        runtime: { nanoseconds: 0, seconds: 0n },
        seasonNumber: 1,
        showReference: "show",
      },
    ]);
  });

  it("rejects inconsistent pages and nested references before persistence", () => {
    const mismatched = fullMovie();
    const source = mismatched.sources[0];
    if (source === undefined) {
      throw new Error("movie source fixture is absent");
    }
    source.sourceReference = sourceReference("another-item");

    expect(() =>
      catalogPageFromPlugin(
        PROVIDER_INSTANCE_ID,
        CORE_RUN_ID,
        create(ListItemsResponseSchema, {
          complete: true,
          consistency: ListConsistency.BEST_EFFORT_SCAN,
          items: [mismatched],
          nextPageToken: "impossible-next-page",
        }),
      ),
    ).toThrow("invalid plugin catalog page");
  });

  it.each([
    ["year only", { day: 0, month: 0, year: 2026 }],
    ["year and month", { day: 0, month: 8, year: 2026 }],
    ["month and day", { day: 25, month: 8, year: 0 }],
  ])("omits a contract-valid partial %s date", (_description, releaseDate) => {
    const movie = fullMovie();
    if (movie.kindDetails.case !== "movie") {
      throw new Error("movie details fixture is absent");
    }
    movie.kindDetails.value.releaseDate = create(DateSchema, releaseDate);

    const page = catalogPageFromPlugin(
      PROVIDER_INSTANCE_ID,
      CORE_RUN_ID,
      create(ListItemsResponseSchema, {
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [movie],
      }),
    );

    expect(page.items[0]).not.toHaveProperty("releaseDate");
  });

  it.each([
    ["an out-of-range month", { day: 1, month: 13, year: 2026 }],
    ["an impossible leap day", { day: 29, month: 2, year: 2025 }],
  ])("rejects %s before persistence", (_description, releaseDate) => {
    const movie = fullMovie();
    if (movie.kindDetails.case !== "movie") {
      throw new Error("movie details fixture is absent");
    }
    movie.kindDetails.value.releaseDate = create(DateSchema, releaseDate);

    expect(() =>
      catalogPageFromPlugin(
        PROVIDER_INSTANCE_ID,
        CORE_RUN_ID,
        create(ListItemsResponseSchema, {
          complete: true,
          consistency: ListConsistency.BEST_EFFORT_SCAN,
          items: [movie],
        }),
      ),
    ).toThrow("invalid plugin catalog page");
  });

  it("coalesces exact duplicate nested provider references", () => {
    const movie = fullMovie();
    const artwork = movie.artwork[0];
    const source = movie.sources[0];
    const part = source?.parts[0];
    const track = part?.tracks[0];
    if (
      artwork === undefined ||
      source === undefined ||
      part === undefined ||
      track === undefined
    ) {
      throw new Error("complete movie fixture is absent");
    }
    movie.artwork.push(artwork);
    part.tracks.push(track);
    source.parts.push(part);
    movie.sources.push(source);

    const page = catalogPageFromPlugin(
      PROVIDER_INSTANCE_ID,
      CORE_RUN_ID,
      create(ListItemsResponseSchema, {
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [movie],
      }),
    );

    const mapped = page.items[0];
    const mappedSource = mapped?.sources[0];
    const mappedPart = mappedSource?.parts[0];
    expect(mapped?.artwork).toHaveLength(1);
    expect(mapped?.sources).toHaveLength(1);
    expect(mappedSource?.parts).toHaveLength(1);
    expect(mappedPart?.tracks).toHaveLength(1);
  });

  it("rejects conflicting observations for one nested provider reference", () => {
    const movie = fullMovie();
    const conflictingSource = fullMovie().sources[0];
    if (conflictingSource === undefined) {
      throw new Error("movie source fixture is absent");
    }
    conflictingSource.label = "Conflicting source";
    movie.sources.push(conflictingSource);

    expect(() =>
      catalogPageFromPlugin(
        PROVIDER_INSTANCE_ID,
        CORE_RUN_ID,
        create(ListItemsResponseSchema, {
          complete: true,
          consistency: ListConsistency.BEST_EFFORT_SCAN,
          items: [movie],
        }),
      ),
    ).toThrow("invalid plugin catalog page");
  });
});
