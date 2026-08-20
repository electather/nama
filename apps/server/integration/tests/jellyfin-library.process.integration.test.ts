import { once } from "node:events";
// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, unicorn/max-nested-calls -- The real subprocess scenario keeps provider fixtures and complete wire expectations visible at one boundary.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import {
  ArtworkRole,
  ArtworkTextPresence,
  DynamicRange,
  MediaCreditRole,
  MediaKind,
  SourceAvailability,
  SpatialAudioFormat,
  SubtitleRepresentation,
} from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";
import { PluginService, ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect, Fiber } from "effect";

import { PluginSupervisor } from "../../src/plugin/supervisor.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 2000;
const TEST_TIMEOUT_MILLISECONDS = 10_000;
const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const OVERSIZED_RESPONSE_PADDING_LENGTH = 1_100_000;
const API_KEY = "jellyfin-api-key-sentinel";
const USER_ID = "user-identity";
const MOVIE_ID = "movie-identity";
const INTERNATIONALIZED_TEXT_REPETITIONS = 50;
const INTERNATIONALIZED_MOVIE_ID = "映画".repeat(INTERNATIONALIZED_TEXT_REPETITIONS);
const INTERNATIONALIZED_MOVIE_TITLE = "到着".repeat(INTERNATIONALIZED_TEXT_REPETITIONS);
const PRIVATE_PATH = "/media/private/Arrival (2016)/Arrival.mkv";
const AUTHORIZED_URL = `/Videos/${MOVIE_ID}/stream?api_key=${API_KEY}`;
const MISSING_MOVIE_ID = "missing-movie";
const FORBIDDEN_MOVIE_ID = "forbidden-movie";
const UNAVAILABLE_MOVIE_ID = "unavailable-movie";
const OVERSIZED_MOVIE_ID = "oversized-movie";
const MALFORMED_JSON_MOVIE_ID = "malformed-json-movie";
const MALFORMED_MOVIE_ID = "malformed-movie";
const CANCELED_MOVIE_ID = "canceled-movie";
const SOURCELESS_MOVIE_ID = "sourceless-movie";
const UNKNOWN_AVAILABILITY_MOVIE_ID = "unknown-availability-movie";
const MALFORMED_DATE_MOVIE_ID = "malformed-date-movie";
const PROVIDER_ERROR_SENTINEL = "private-provider-error-sentinel";
const OVERSIZED_RESPONSE_BODY = JSON.stringify({
  Id: OVERSIZED_MOVIE_ID,
  Padding: `${PROVIDER_ERROR_SENTINEL}:${"x".repeat(OVERSIZED_RESPONSE_PADDING_LENGTH)}`,
  Path: PRIVATE_PATH,
  Type: "Movie",
});

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly url: string;
}

interface ControlledJellyfin {
  readonly baseUrl: string;
  readonly cancellationObserved: Promise<void>;
  readonly hangingRequestObserved: Promise<void>;
  readonly requests: ObservedRequest[];
  readonly server: Server;
}

const MOVIE_RESPONSE = {
  BackdropImageTags: ["backdrop-tag-a", "backdrop-tag-b"],
  Genres: ["Drama", "Science Fiction"],
  Id: MOVIE_ID,
  ImageTags: {
    Banner: "ignored-banner-tag",
    Logo: "logo-tag",
    Primary: "poster-tag",
    Thumb: "thumbnail-tag",
  },
  LocationType: "FileSystem",
  MediaSources: [
    {
      Bitrate: 50_000_000,
      Container: "mkv",
      Id: "source-4k",
      MediaStreams: [
        {
          AverageFrameRate: 23.976,
          BitDepth: 10,
          Codec: "hevc",
          Height: 2160,
          Index: 0,
          Type: "Video",
          VideoRangeType: "DOVIWithHDR10",
          Width: 3840,
        },
        {
          AudioSpatialFormat: "DolbyAtmos",
          ChannelLayout: "7.1",
          Channels: 8,
          Codec: "truehd",
          Index: 1,
          IsCommentary: false,
          IsDefault: true,
          Language: "eng",
          SampleRate: 48_000,
          Title: "English Atmos",
          Type: "Audio",
        },
        {
          Codec: "srt",
          Index: 2,
          IsCommentary: false,
          IsDefault: false,
          IsForced: true,
          IsHearingImpaired: true,
          IsTextSubtitleStream: true,
          Language: "eng",
          Path: "/media/private/Arrival.en.srt",
          Title: "English SDH",
          Type: "Subtitle",
        },
        { Codec: "bin", Index: 3, Type: "Data" },
      ],
      Name: "4K Dolby Vision",
      Path: PRIVATE_PATH,
      RequiredHttpHeaders: { Authorization: `MediaBrowser Token="${API_KEY}"` },
      RunTimeTicks: 69_600_000_000,
      Size: 75_000_000_000,
      TranscodingUrl: AUTHORIZED_URL,
      Type: "Default",
    },
    {
      Bitrate: 8_000_000,
      Container: "mp4",
      Id: "source-1080p",
      MediaStreams: [
        {
          Codec: "h264",
          Height: 1080,
          Index: 0,
          Type: "Video",
          VideoRangeType: "SDR",
          Width: 1920,
        },
        {
          AudioSpatialFormat: "None",
          Channels: 2,
          Codec: "aac",
          Index: 1,
          IsCommentary: false,
          IsDefault: true,
          Language: "eng",
          Type: "Audio",
        },
      ],
      Name: "1080p",
      Path: "/media/private/Arrival-1080p.mp4",
      Size: 12_000_000_000,
      Type: "Default",
    },
  ],
  Name: "Arrival",
  OfficialRating: "PG-13",
  OriginalTitle: "Story of Your Life",
  Overview: "A linguist works with the military to communicate with alien lifeforms.",
  Path: PRIVATE_PATH,
  People: [
    {
      Id: "person-actor",
      Name: "Amy Adams",
      PrimaryImageTag: "actor-portrait-tag",
      Role: "Louise Banks",
      Type: "Actor",
    },
    {
      Id: "person-director",
      Name: "Denis Villeneuve",
      PrimaryImageTag: "director-portrait-tag",
      Type: "Director",
    },
    { Name: "Eric Heisserer", Type: "Writer" },
    { Name: "Jóhann Jóhannsson", Type: "Composer" },
  ],
  PlayAccess: "Full",
  PremiereDate: "2016-09-01T00:00:00.0000000Z",
  ProductionYear: 2016,
  ProviderIds: {
    Imdb: "tt2543164",
    Tmdb: "329865",
    Trakt: "182156",
    Tvdb: "10119677",
  },
  RunTimeTicks: 69_600_000_000,
  Studios: [{ Name: "Paramount Pictures" }, { Name: "FilmNation Entertainment" }],
  Taglines: ["Why are they here?"],
  Type: "Movie",
};
const INTERNATIONALIZED_MOVIE_RESPONSE = {
  Id: INTERNATIONALIZED_MOVIE_ID,
  MediaSources: [],
  Name: INTERNATIONALIZED_MOVIE_TITLE,
  PlayAccess: "Full",
  Type: "Movie",
};
const SOURCELESS_MOVIE_RESPONSE = {
  Id: SOURCELESS_MOVIE_ID,
  MediaSources: [],
  Name: "Source-less movie",
  PlayAccess: "Full",
  Type: "Movie",
};
const UNKNOWN_AVAILABILITY_MOVIE_RESPONSE = {
  ...MOVIE_RESPONSE,
  Id: UNKNOWN_AVAILABILITY_MOVIE_ID,
  LocationType: "Unexpected",
};
const MALFORMED_DATE_MOVIE_RESPONSE = {
  ...MOVIE_RESPONSE,
  Id: MALFORMED_DATE_MOVIE_ID,
  PremiereDate: "2016-09-01Tgarbage",
};

const respondJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

const respondRaw = (response: ServerResponse, statusCode: number, body: string): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(body);
};

const acquireControlledJellyfin = Effect.acquireRelease(
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<ControlledJellyfin> => {
      const requests: ObservedRequest[] = [];
      const hangingRequest = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        requests.push({ authorization: request.headers.authorization, url: request.url ?? "" });
        if (
          request.url === `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}` &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondJson(response, MOVIE_RESPONSE);
          return;
        }
        if (
          request.url ===
          `/jellyfin/Items/${encodeURIComponent(INTERNATIONALIZED_MOVIE_ID)}?userId=${USER_ID}`
        ) {
          respondJson(response, INTERNATIONALIZED_MOVIE_RESPONSE);
          return;
        }
        if (request.url === `/jellyfin/Items/${SOURCELESS_MOVIE_ID}?userId=${USER_ID}`) {
          respondJson(response, SOURCELESS_MOVIE_RESPONSE);
          return;
        }
        if (request.url === `/jellyfin/Items/${UNKNOWN_AVAILABILITY_MOVIE_ID}?userId=${USER_ID}`) {
          respondJson(response, UNKNOWN_AVAILABILITY_MOVIE_RESPONSE);
          return;
        }
        if (request.url === `/jellyfin/Items/${MALFORMED_DATE_MOVIE_ID}?userId=${USER_ID}`) {
          respondJson(response, MALFORMED_DATE_MOVIE_RESPONSE);
          return;
        }
        if (request.url === `/jellyfin/Items/${FORBIDDEN_MOVIE_ID}?userId=${USER_ID}`) {
          respondRaw(
            response,
            HTTP_FORBIDDEN,
            `${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}:MediaBrowser Token="${API_KEY}"`,
          );
          return;
        }
        if (request.url === `/jellyfin/Items/${UNAVAILABLE_MOVIE_ID}?userId=${USER_ID}`) {
          respondRaw(
            response,
            HTTP_UNAVAILABLE,
            `${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}:MediaBrowser Token="${API_KEY}"`,
          );
          return;
        }
        if (request.url === `/jellyfin/Items/${OVERSIZED_MOVIE_ID}?userId=${USER_ID}`) {
          respondRaw(response, HTTP_OK, OVERSIZED_RESPONSE_BODY);
          return;
        }
        if (request.url === `/jellyfin/Items/${MALFORMED_JSON_MOVIE_ID}?userId=${USER_ID}`) {
          respondRaw(response, HTTP_OK, `{${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}`);
          return;
        }
        if (request.url === `/jellyfin/Items/${MALFORMED_MOVIE_ID}?userId=${USER_ID}`) {
          respondJson(response, {
            Id: MALFORMED_MOVIE_ID,
            MediaSources: [],
            Path: PRIVATE_PATH,
            PlayAccess: "Full",
            Type: "Movie",
          });
          return;
        }
        if (request.url === `/jellyfin/Items/${CANCELED_MOVIE_ID}?userId=${USER_ID}`) {
          hangingRequest.resolve();
          response.once("close", cancellation.resolve);
          return;
        }
        response.statusCode = HTTP_NOT_FOUND;
        response.end();
      });
      server.listen(EPHEMERAL_PORT, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Controlled Jellyfin server did not bind to a TCP address");
      }
      return {
        baseUrl: `http://127.0.0.1:${address.port}/jellyfin`,
        cancellationObserved: cancellation.promise,
        hangingRequestObserved: hangingRequest.promise,
        requests,
        server,
      };
    },
  }),
  ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
);

const assertNormalizedMetadata = (item: ProviderMediaItem) => {
  expect(item).toMatchObject({
    artwork: [
      {
        artworkReference: {
          artworkId: "Primary:poster-tag",
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.POSTER,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          artworkId: "Backdrop:0:backdrop-tag-a",
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.BACKDROP,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          artworkId: "Backdrop:1:backdrop-tag-b",
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.BACKDROP,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          artworkId: "Logo:logo-tag",
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.LOGO,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          artworkId: "Thumb:thumbnail-tag",
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.THUMBNAIL,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
    ],
    contentRating: "PG-13",
    credits: [
      {
        characterName: "Louise Banks",
        name: "Amy Adams",
        portraitArtworkReference: {
          artworkId: "Primary:actor-portrait-tag",
          itemReference: { itemId: "person-actor" },
        },
        role: MediaCreditRole.ACTOR,
      },
      {
        name: "Denis Villeneuve",
        portraitArtworkReference: {
          artworkId: "Primary:director-portrait-tag",
          itemReference: { itemId: "person-director" },
        },
        role: MediaCreditRole.DIRECTOR,
      },
      { name: "Eric Heisserer", role: MediaCreditRole.WRITER },
    ],
    externalIdentifiers: [
      { namespace: "imdb", value: "tt2543164" },
      { namespace: "tmdb", value: "329865" },
      { namespace: "tvdb", value: "10119677" },
    ],
    genres: ["Drama", "Science Fiction"],
    itemReference: { itemId: MOVIE_ID },
    kind: MediaKind.MOVIE,
    kindDetails: {
      case: "movie",
      value: { releaseDate: { day: 1, month: 9, year: 2016 } },
    },
    originalTitle: "Story of Your Life",
    releaseYear: 2016,
    runtime: { nanos: 0, seconds: 6960n },
    studios: ["Paramount Pictures", "FilmNation Entertainment"],
    synopsis: "A linguist works with the military to communicate with alien lifeforms.",
    tagline: "Why are they here?",
    title: "Arrival",
  });
};

const assertNormalizedSources = (item: ProviderMediaItem) => {
  expect(item.sources).toMatchObject([
    {
      availability: SourceAvailability.AVAILABLE,
      bitRateBps: 50_000_000n,
      label: "4K Dolby Vision",
      parts: [
        {
          bitRateBps: 50_000_000n,
          container: "mkv",
          order: 0,
          partReference: {
            partId: "source-4k",
            sourceReference: {
              itemReference: { itemId: MOVIE_ID },
              sourceId: "source-4k",
            },
          },
          runtime: { nanos: 0, seconds: 6960n },
          sizeBytes: 75_000_000_000n,
          tracks: [
            {
              details: {
                case: "video",
                value: {
                  bitDepth: 10,
                  codec: "hevc",
                  dynamicRange: DynamicRange.DOLBY_VISION,
                  frameRate: 23.976,
                  height: 2160,
                  width: 3840,
                },
              },
              order: 0,
              trackReference: {
                partReference: {
                  partId: "source-4k",
                  sourceReference: {
                    itemReference: { itemId: MOVIE_ID },
                    sourceId: "source-4k",
                  },
                },
                trackId: "0",
              },
            },
            {
              details: {
                case: "audio",
                value: {
                  channelCount: 8,
                  channelLayout: "7.1",
                  codec: "truehd",
                  isCommentary: false,
                  isDefault: true,
                  language: "eng",
                  sampleRateHz: 48_000,
                  spatialFormat: SpatialAudioFormat.DOLBY_ATMOS,
                  title: "English Atmos",
                },
              },
              order: 1,
              trackReference: {
                partReference: {
                  partId: "source-4k",
                  sourceReference: {
                    itemReference: { itemId: MOVIE_ID },
                    sourceId: "source-4k",
                  },
                },
                trackId: "1",
              },
            },
            {
              details: {
                case: "subtitle",
                value: {
                  codec: "srt",
                  isCommentary: false,
                  isDefault: false,
                  isForced: true,
                  isHearingImpaired: true,
                  language: "eng",
                  representation: SubtitleRepresentation.TEXT,
                  title: "English SDH",
                },
              },
              order: 2,
              trackReference: {
                partReference: {
                  partId: "source-4k",
                  sourceReference: {
                    itemReference: { itemId: MOVIE_ID },
                    sourceId: "source-4k",
                  },
                },
                trackId: "2",
              },
            },
          ],
        },
      ],
      runtime: { nanos: 0, seconds: 6960n },
      sourceReference: {
        itemReference: { itemId: MOVIE_ID },
        sourceId: "source-4k",
      },
    },
    {
      availability: SourceAvailability.AVAILABLE,
      bitRateBps: 8_000_000n,
      label: "1080p",
      parts: [
        {
          bitRateBps: 8_000_000n,
          container: "mp4",
          order: 0,
          partReference: {
            partId: "source-1080p",
            sourceReference: {
              itemReference: { itemId: MOVIE_ID },
              sourceId: "source-1080p",
            },
          },
          sizeBytes: 12_000_000_000n,
          tracks: [
            {
              details: {
                case: "video",
                value: {
                  codec: "h264",
                  dynamicRange: DynamicRange.SDR,
                  height: 1080,
                  width: 1920,
                },
              },
              order: 0,
              trackReference: {
                partReference: {
                  partId: "source-1080p",
                  sourceReference: {
                    itemReference: { itemId: MOVIE_ID },
                    sourceId: "source-1080p",
                  },
                },
                trackId: "0",
              },
            },
            {
              details: {
                case: "audio",
                value: {
                  channelCount: 2,
                  codec: "aac",
                  isCommentary: false,
                  isDefault: true,
                  language: "eng",
                  spatialFormat: SpatialAudioFormat.NONE,
                },
              },
              order: 1,
              trackReference: {
                partReference: {
                  partId: "source-1080p",
                  sourceReference: {
                    itemReference: { itemId: MOVIE_ID },
                    sourceId: "source-1080p",
                  },
                },
                trackId: "1",
              },
            },
          ],
        },
      ],
      sourceReference: {
        itemReference: { itemId: MOVIE_ID },
        sourceId: "source-1080p",
      },
    },
  ]);
};

it.live(
  "returns one normalized movie through the targeted library RPC",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinMovieObservationTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
            credentials: { api_key: API_KEY },
            kind: "instance",
            providerInstanceId: "provider-instance",
            revision: "revision-1",
          },
        );
        const info = yield* plugin.call(
          PluginService.method.getInfo,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(info.pluginInfo?.capabilities).toEqual([ProviderCapability.WATCHED_WRITE]);

        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        if (response.item === undefined) {
          throw new Error("Jellyfin movie observation was absent");
        }

        assertNormalizedMetadata(response.item);
        assertNormalizedSources(response.item);
        const sourcelessResponse = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: SOURCELESS_MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(sourcelessResponse.item).toMatchObject({
          itemReference: { itemId: SOURCELESS_MOVIE_ID },
          kind: MediaKind.MOVIE,
          kindDetails: { case: "movie", value: {} },
          sources: [],
          title: "Source-less movie",
        });
        expect(sourcelessResponse.item?.runtime).toBeUndefined();
        expect(jellyfin.requests).toEqual([
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            url: `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}`,
          },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            url: `/jellyfin/Items/${SOURCELESS_MOVIE_ID}?userId=${USER_ID}`,
          },
        ]);
        const serialized = JSON.stringify(response, (_key, value: unknown) => {
          if (typeof value === "bigint") {
            return value.toString();
          }
          return value;
        });
        expect(serialized).not.toContain(PRIVATE_PATH);
        expect(serialized).not.toContain(AUTHORIZED_URL);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain("Trakt");
        expect(serialized).not.toContain("182156");
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "accepts contract-valid internationalized references and metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinInternationalizedMovieTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
            credentials: { api_key: API_KEY },
            kind: "instance",
            providerInstanceId: "provider-instance",
            revision: "revision-1",
          },
        );

        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: INTERNATIONALIZED_MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(response.item).toMatchObject({
          itemReference: { itemId: INTERNATIONALIZED_MOVIE_ID },
          title: INTERNATIONALIZED_MOVIE_TITLE,
        });
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "returns safe outcomes for unsuccessful targeted movie reads",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinMovieFailureTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
            credentials: { api_key: API_KEY },
            kind: "instance",
            providerInstanceId: "provider-instance",
            revision: "revision-1",
          },
        );
        const cases = [
          [MISSING_MOVIE_ID, Code.NotFound],
          [FORBIDDEN_MOVIE_ID, Code.PermissionDenied],
          [UNAVAILABLE_MOVIE_ID, Code.Unavailable],
          [OVERSIZED_MOVIE_ID, Code.Internal],
          [MALFORMED_JSON_MOVIE_ID, Code.Internal],
          [MALFORMED_MOVIE_ID, Code.Internal],
          [UNKNOWN_AVAILABILITY_MOVIE_ID, Code.Internal],
          [MALFORMED_DATE_MOVIE_ID, Code.Internal],
        ] as const;
        for (const [itemId, code] of cases) {
          const failure = yield* plugin
            .call(
              LibraryService.method.getItem,
              { itemReference: { itemId } },
              CALL_DEADLINE_MILLISECONDS,
            )
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "PluginRpcError", code });
          const serializedFailure = JSON.stringify(failure);
          expect(serializedFailure).not.toContain(API_KEY);
          expect(serializedFailure).not.toContain(PRIVATE_PATH);
          expect(serializedFailure).not.toContain(PROVIDER_ERROR_SENTINEL);
        }

        const canceledCall = yield* Effect.forkChild(
          plugin.call(
            LibraryService.method.getItem,
            { itemReference: { itemId: CANCELED_MOVIE_ID } },
            TEST_TIMEOUT_MILLISECONDS,
          ),
        );
        yield* Effect.promise(() => jellyfin.hangingRequestObserved);
        yield* Fiber.interrupt(canceledCall);
        yield* Effect.promise(() => jellyfin.cancellationObserved);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
