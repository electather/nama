import { once } from "node:events";
// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, unicorn/max-nested-calls -- The real subprocess scenario keeps provider fixtures, production adapters, and complete wire expectations visible at one boundary.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";

import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import {
  LibraryService as PublicLibraryService,
  HomeSectionKind,
  LibrarySort,
  WatchFilter,
} from "@nama/api/nama/api/v1/library_pb.js";
import {
  MediaKind as PublicMediaKind,
  Playability as PublicPlayability,
} from "@nama/api/nama/api/v1/media_pb.js";
import { LibraryService, ListConsistency } from "@nama/api/nama/plugin/v1/library_pb.js";
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
import { ProviderCapability as PluginProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { AuthenticationService } from "../../src/authentication/authentication-service.ts";
import type { ArtworkAccessService } from "../../src/catalog/catalog-artwork-access.ts";
import { makeArtworkAssetLoader } from "../../src/catalog/catalog-artwork-asset-fetch.ts";
import { makeCatalogArtworkLeaseResolver } from "../../src/catalog/catalog-artwork-resolver.ts";
import { makeCatalogImport } from "../../src/catalog/catalog-import.ts";
import { listProviderCatalogPage } from "../../src/catalog/catalog-provider-access.ts";
import { CatalogQuery } from "../../src/catalog/catalog-query-live.ts";
import { makeCatalogQuery } from "../../src/catalog/catalog-query.ts";
import { Database } from "../../src/database/database.ts";
import { startServer } from "../../src/http/tests/http-server.test-support.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import { initializeCatalogDatabase } from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { collectPublicReferenceValues } from "./provider-boundary.test-support.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const EXPIRED_CLOCK_PRELOAD_URL = `data:text/javascript,${encodeURIComponent(
  "Date.now = () => 946684800000;",
)}`;
const CALL_DEADLINE_MILLISECONDS = 2000;
const TEST_TIMEOUT_MILLISECONDS = 10_000;
const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const OVERSIZED_RESPONSE_PADDING_LENGTH = 1_100_000;
const OVERSIZED_CATALOG_PADDING_LENGTH = 16_777_216;
const CATALOG_PAGE_SIZE = 2;
const IDLE_RETIREMENT_MILLISECONDS = 30_000;
const SINGLE_ITEM_COUNT = 1;
const FIRST_CODE_UNIT_LENGTH = 1;
const CATALOG_CONTINUATION_PROVIDER_REQUEST_COUNT = 2;
const NO_PROVIDER_REQUESTS = 0;
const CATALOG_IMPORT_POLL_MILLISECONDS = 25;
const CATALOG_IMPORT_WAIT_MILLISECONDS = 10_000;
const CATALOG_IMPORT_PROCESS_TIMEOUT_MILLISECONDS = 30_000;
const CORE_CATALOG_PAGE_SIZE = 100;
const FIRST_COLLECTION_INDEX = 0;
const PUBLIC_LIBRARY_MASTER_KEY_BYTES = 32;
const PUBLIC_LIBRARY_MASTER_KEY_FILL = 83;
const PUBLIC_LIBRARY_PROVIDER_TRACK_STRIDE = 100;
const CATALOG_PROVIDER_INSTANCE_ID = "provider-instance";
const CATALOG_PROVIDER_REVISION = `${CATALOG_PROVIDER_INSTANCE_ID}-revision`;
const API_KEY = "jellyfin-api-key-sentinel";
const CANONICAL_ARTWORK_BYTES = Buffer.from("canonical-artwork", "utf8");
const NO_ARTWORK_ASSET = undefined;
const USER_ID = "user-identity";
const MOVIE_ID = "movie-identity";
const SHOW_ID = "show-identity";
const SPARSE_SHOW_ID = "sparse-show";
const SEASON_ID = "season-identity";
const EPISODE_ID = "episode-identity";
const SPECIALS_SEASON_ID = "specials-season";
const SPECIAL_EPISODE_ID = "special-episode";
const SPARSE_EPISODE_ID = "sparse-episode";
const MALFORMED_SHOW_ID = "malformed-show";
const MALFORMED_SEASON_ID = "malformed-season";
const MALFORMED_EPISODE_ID = "malformed-episode";
const ZERO_EPISODE_ID = "zero-episode";
const UNSUPPORTED_AUDIO_ID = "unsupported-audio";
const UNSUPPORTED_PHOTO_ID = "unsupported-photo";
const INTERNATIONALIZED_TEXT_REPETITIONS = 50;
const INTERNATIONALIZED_MOVIE_ID = "映画".repeat(INTERNATIONALIZED_TEXT_REPETITIONS);
const INTERNATIONALIZED_MOVIE_TITLE = "到着".repeat(INTERNATIONALIZED_TEXT_REPETITIONS);
const PRIVATE_PATH = "/media/private/Arrival (2016)/Arrival.mkv";
const AUTHORIZED_URL = `/Videos/${MOVIE_ID}/stream?api_key=${API_KEY}`;
const MISSING_MOVIE_ID = "missing-movie";
const FORBIDDEN_MOVIE_ID = "forbidden-movie";
const UNAVAILABLE_MOVIE_ID = "unavailable-movie";
const STREAMING_UNAVAILABLE_MOVIE_ID = "streaming-unavailable-movie";
const OVERSIZED_MOVIE_ID = "oversized-movie";
const MALFORMED_JSON_MOVIE_ID = "malformed-json-movie";
const MALFORMED_MOVIE_ID = "malformed-movie";
const CANCELED_MOVIE_ID = "canceled-movie";
const SOURCELESS_MOVIE_ID = "sourceless-movie";
const OFFLINE_MOVIE_ID = "offline-movie";
const OFFLINE_SOURCE_ID = "offline-source";
const UNSUPPORTED_SOURCE_MOVIE_ID = "unsupported-source-movie";
const UNSUPPORTED_SOURCE_ID = "unsupported-source";
const UNKNOWN_AVAILABILITY_MOVIE_ID = "unknown-availability-movie";
const MISSING_AVAILABILITY_MOVIE_ID = "missing-availability-movie";
const MALFORMED_DATE_MOVIE_ID = "malformed-date-movie";
const PROVIDER_PREFIX_ESCAPE_ID = "..";
const PROVIDER_ERROR_SENTINEL = "private-provider-error-sentinel";
const OPAQUE_ARTWORK_REFERENCE = /^jellyfin\/artwork\/v1:[\w-]+$/u;
const OVERSIZED_RESPONSE_BODY = JSON.stringify({
  Id: OVERSIZED_MOVIE_ID,
  Padding: `${PROVIDER_ERROR_SENTINEL}:${"x".repeat(OVERSIZED_RESPONSE_PADDING_LENGTH)}`,
  Path: PRIVATE_PATH,
  Type: "Movie",
});

type CatalogResponseMode =
  | "canceled"
  | "forbidden"
  | "malformed_item"
  | "malformed_json"
  | "normal"
  | "oversized"
  | "unavailable";

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly url: string;
}

interface ControlledJellyfin {
  readonly catalog: {
    hangAtStartIndex: number | undefined;
    mode: CatalogResponseMode;
    responses: readonly unknown[];
  };
  readonly baseUrl: string;
  readonly cancellationObserved: Promise<void>;
  readonly failureBodyCancellationObserved: Promise<void>;
  readonly failureBodyObserved: Promise<void>;
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
const SHOW_RESPONSE = {
  BackdropImageTags: ["show-backdrop-tag"],
  ChildCount: 3,
  EndDate: "2020-06-27T00:00:00.0000000Z",
  Genres: ["Crime", "Drama", "Mystery"],
  Id: SHOW_ID,
  ImageTags: {
    Logo: "show-logo-tag",
    Primary: "show-poster-tag",
  },
  Name: "Dark",
  OfficialRating: "TV-MA",
  OriginalTitle: "Dark",
  Overview: "A missing child sets four families on a frantic hunt for answers.",
  People: [{ Id: "show-actor", Name: "Louis Hofmann", Role: "Jonas Kahnwald", Type: "Actor" }],
  PlayAccess: "Full",
  PremiereDate: "2017-12-01T00:00:00.0000000Z",
  ProductionYear: 2017,
  ProviderIds: {
    Imdb: "tt5753856",
    Tmdb: "70523",
    Trakt: "98519",
    Tvdb: "334824",
  },
  RecursiveItemCount: 26,
  Studios: [{ Name: "Wiedemann & Berg Television" }],
  Taglines: ["Everything is connected."],
  Type: "Series",
};
const SPARSE_SHOW_RESPONSE = {
  Id: SPARSE_SHOW_ID,
  Name: "Unknown schedule",
  PlayAccess: "Full",
  Type: "Series",
};
const SEASON_RESPONSE = {
  ChildCount: 8,
  Genres: ["Crime", "Drama"],
  Id: SEASON_ID,
  ImageTags: {
    Primary: "season-poster-tag",
    Thumb: "season-thumbnail-tag",
  },
  IndexNumber: 2,
  Name: "Season 2",
  Overview: "The families confront new truths across time.",
  PlayAccess: "Full",
  ProductionYear: 2019,
  SeriesId: SHOW_ID,
  Studios: [{ Name: "Wiedemann & Berg Television" }],
  Type: "Season",
};
const EPISODE_RESPONSE = {
  ...MOVIE_RESPONSE,
  BackdropImageTags: [],
  Id: EPISODE_ID,
  ImageTags: { Primary: "episode-thumbnail-tag" },
  IndexNumber: 3,
  Name: "An Endless Cycle",
  ParentIndexNumber: 2,
  PremiereDate: "2019-07-05T00:00:00.0000000Z",
  ProductionYear: 2019,
  SeasonId: SEASON_ID,
  SeriesId: SHOW_ID,
  Type: "Episode",
};
const SPECIALS_SEASON_RESPONSE = {
  Id: SPECIALS_SEASON_ID,
  IndexNumber: 0,
  Name: "Specials",
  PlayAccess: "Full",
  SeriesId: SHOW_ID,
  Type: "Season",
};
const SPECIAL_EPISODE_RESPONSE = {
  Id: SPECIAL_EPISODE_ID,
  IndexNumber: 1,
  MediaSources: [],
  Name: "Behind the scenes",
  ParentIndexNumber: 0,
  PlayAccess: "Full",
  SeasonId: SPECIALS_SEASON_ID,
  SeriesId: SHOW_ID,
  Type: "Episode",
};
const SPARSE_EPISODE_RESPONSE = {
  Id: SPARSE_EPISODE_ID,
  IndexNumber: 1,
  MediaSources: [],
  Name: "Unknown air date",
  ParentIndexNumber: 2,
  PlayAccess: "Full",
  SeasonId: SEASON_ID,
  SeriesId: SHOW_ID,
  Type: "Episode",
};
const MALFORMED_SHOW_RESPONSE = {
  ChildCount: -1,
  Id: MALFORMED_SHOW_ID,
  Name: "Malformed show",
  PlayAccess: "Full",
  Type: "Series",
};
const MALFORMED_SEASON_RESPONSE = {
  Id: MALFORMED_SEASON_ID,
  IndexNumber: 1,
  Name: "Malformed season",
  PlayAccess: "Full",
  Type: "Season",
};
const MALFORMED_EPISODE_RESPONSE = {
  Id: MALFORMED_EPISODE_ID,
  IndexNumber: 1,
  MediaSources: [],
  Name: "Malformed episode",
  ParentIndexNumber: 2,
  PlayAccess: "Full",
  SeriesId: SHOW_ID,
  Type: "Episode",
};
const ZERO_EPISODE_RESPONSE = {
  Id: ZERO_EPISODE_ID,
  IndexNumber: 0,
  MediaSources: [],
  Name: "Malformed episode number",
  ParentIndexNumber: 2,
  PlayAccess: "Full",
  SeasonId: SEASON_ID,
  SeriesId: SHOW_ID,
  Type: "Episode",
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
const OFFLINE_MOVIE_RESPONSE = {
  Id: OFFLINE_MOVIE_ID,
  LocationType: "Offline",
  MediaSources: [
    {
      Container: "mkv",
      Id: OFFLINE_SOURCE_ID,
      MediaStreams: [],
      Path: PRIVATE_PATH,
      RequiredHttpHeaders: { Authorization: `MediaBrowser Token="${API_KEY}"` },
      TranscodingUrl: AUTHORIZED_URL,
      Type: "Default",
    },
  ],
  Name: "Offline movie",
  Path: PRIVATE_PATH,
  PlayAccess: "Full",
  Type: "Movie",
};
const UNSUPPORTED_SOURCE_MOVIE_RESPONSE = {
  Id: UNSUPPORTED_SOURCE_MOVIE_ID,
  LocationType: "Virtual",
  MediaSources: [
    {
      Container: "mkv",
      Id: UNSUPPORTED_SOURCE_ID,
      MediaStreams: [],
      Path: PRIVATE_PATH,
      RequiredHttpHeaders: { Authorization: `MediaBrowser Token="${API_KEY}"` },
      TranscodingUrl: AUTHORIZED_URL,
      Type: "Default",
    },
  ],
  Name: "Unsupported source movie",
  Path: PRIVATE_PATH,
  PlayAccess: "Full",
  Type: "Movie",
};
const MALFORMED_MOVIE_RESPONSE = {
  Id: MALFORMED_MOVIE_ID,
  MediaSources: [],
  Path: PRIVATE_PATH,
  PlayAccess: "Full",
  Type: "Movie",
};
const MISSING_AVAILABILITY_MOVIE_RESPONSE = {
  ...MOVIE_RESPONSE,
  Id: MISSING_AVAILABILITY_MOVIE_ID,
  LocationType: undefined,
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
const UNSUPPORTED_AUDIO_RESPONSE = {
  Id: UNSUPPORTED_AUDIO_ID,
  Name: "Unsupported audio",
  PlayAccess: "Full",
  Type: "Audio",
};
const UNSUPPORTED_PHOTO_RESPONSE = {
  Id: UNSUPPORTED_PHOTO_ID,
  Name: "Unsupported photo",
  PlayAccess: "Full",
  Type: "Photo",
};

const CATALOG_RESPONSES = [
  MOVIE_RESPONSE,
  SHOW_RESPONSE,
  SPECIALS_SEASON_RESPONSE,
  SEASON_RESPONSE,
  SPECIAL_EPISODE_RESPONSE,
  EPISODE_RESPONSE,
  UNSUPPORTED_AUDIO_RESPONSE,
  UNSUPPORTED_PHOTO_RESPONSE,
] as const;

const TARGETED_ITEM_RESPONSE_BY_URL: Readonly<Record<string, unknown>> = {
  [`/jellyfin/Items/${encodeURIComponent(INTERNATIONALIZED_MOVIE_ID)}?userId=${USER_ID}`]:
    INTERNATIONALIZED_MOVIE_RESPONSE,
  [`/jellyfin/Items/${SHOW_ID}?userId=${USER_ID}`]: SHOW_RESPONSE,
  [`/jellyfin/Items/${SPARSE_SHOW_ID}?userId=${USER_ID}`]: SPARSE_SHOW_RESPONSE,
  [`/jellyfin/Items/${SEASON_ID}?userId=${USER_ID}`]: SEASON_RESPONSE,
  [`/jellyfin/Items/${EPISODE_ID}?userId=${USER_ID}`]: EPISODE_RESPONSE,
  [`/jellyfin/Items/${SPECIALS_SEASON_ID}?userId=${USER_ID}`]: SPECIALS_SEASON_RESPONSE,
  [`/jellyfin/Items/${SPECIAL_EPISODE_ID}?userId=${USER_ID}`]: SPECIAL_EPISODE_RESPONSE,
  [`/jellyfin/Items/${SPARSE_EPISODE_ID}?userId=${USER_ID}`]: SPARSE_EPISODE_RESPONSE,
  [`/jellyfin/Items/${MALFORMED_SHOW_ID}?userId=${USER_ID}`]: MALFORMED_SHOW_RESPONSE,
  [`/jellyfin/Items/${MALFORMED_SEASON_ID}?userId=${USER_ID}`]: MALFORMED_SEASON_RESPONSE,
  [`/jellyfin/Items/${MALFORMED_EPISODE_ID}?userId=${USER_ID}`]: MALFORMED_EPISODE_RESPONSE,
  [`/jellyfin/Items/${ZERO_EPISODE_ID}?userId=${USER_ID}`]: ZERO_EPISODE_RESPONSE,
  [`/jellyfin/Items/${SOURCELESS_MOVIE_ID}?userId=${USER_ID}`]: SOURCELESS_MOVIE_RESPONSE,
  [`/jellyfin/Items/${OFFLINE_MOVIE_ID}?userId=${USER_ID}`]: OFFLINE_MOVIE_RESPONSE,
  [`/jellyfin/Items/${UNSUPPORTED_SOURCE_MOVIE_ID}?userId=${USER_ID}`]:
    UNSUPPORTED_SOURCE_MOVIE_RESPONSE,
  [`/jellyfin/Items/${MISSING_AVAILABILITY_MOVIE_ID}?userId=${USER_ID}`]:
    MISSING_AVAILABILITY_MOVIE_RESPONSE,
  [`/jellyfin/Items/${UNKNOWN_AVAILABILITY_MOVIE_ID}?userId=${USER_ID}`]:
    UNKNOWN_AVAILABILITY_MOVIE_RESPONSE,
  [`/jellyfin/Items/${MALFORMED_DATE_MOVIE_ID}?userId=${USER_ID}`]: MALFORMED_DATE_MOVIE_RESPONSE,
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

const publicBoundaryJson = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === "bigint") {
      return field.toString();
    }
    return field;
  });

const acquireControlledJellyfin = Effect.acquireRelease(
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<ControlledJellyfin> => {
      const requests: ObservedRequest[] = [];
      const catalog: ControlledJellyfin["catalog"] = {
        hangAtStartIndex: undefined,
        mode: "normal",
        responses: CATALOG_RESPONSES,
      };
      const hangingRequest = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
      const failureBodyObserved = Promise.withResolvers<void>();
      const failureBodyCancellation = Promise.withResolvers<void>();
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        requests.push({ authorization: request.headers.authorization, url: request.url ?? "" });
        const endpoint = new URL(request.url ?? "", "http://jellyfin.invalid");
        if (
          (request.method === "HEAD" || request.method === "GET") &&
          endpoint.pathname.startsWith("/jellyfin/Items/") &&
          endpoint.pathname.includes("/Images/") &&
          request.headers.authorization === undefined
        ) {
          response.statusCode = HTTP_OK;
          response.setHeader("content-type", "image/jpeg");
          if (request.method === "GET") {
            response.end(CANONICAL_ARTWORK_BYTES);
          } else {
            response.end();
          }
          return;
        }
        if (
          endpoint.pathname === "/jellyfin/Items" &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          if (catalog.mode === "forbidden") {
            respondRaw(
              response,
              HTTP_FORBIDDEN,
              `${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}:MediaBrowser Token="${API_KEY}"`,
            );
            return;
          }
          if (catalog.mode === "unavailable") {
            respondRaw(
              response,
              HTTP_UNAVAILABLE,
              `${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}:MediaBrowser Token="${API_KEY}"`,
            );
            return;
          }
          if (catalog.mode === "malformed_json") {
            respondRaw(response, HTTP_OK, `{${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}`);
            return;
          }
          if (catalog.mode === "malformed_item") {
            respondJson(response, { Items: [MALFORMED_MOVIE_RESPONSE] });
            return;
          }
          if (catalog.mode === "oversized") {
            respondJson(response, {
              Items: [
                {
                  ...MOVIE_RESPONSE,
                  Padding: `${PROVIDER_ERROR_SENTINEL}:${PRIVATE_PATH}:${"x".repeat(
                    OVERSIZED_CATALOG_PADDING_LENGTH,
                  )}`,
                },
              ],
            });
            return;
          }
          if (catalog.mode === "canceled") {
            hangingRequest.resolve();
            response.once("close", cancellation.resolve);
            return;
          }
          const startIndex = Number(endpoint.searchParams.get("startIndex"));
          if (catalog.hangAtStartIndex === startIndex) {
            hangingRequest.resolve();
            response.once("close", cancellation.resolve);
            return;
          }
          const limit = Number(endpoint.searchParams.get("limit"));
          respondJson(response, {
            Items: catalog.responses.slice(startIndex, startIndex + limit),
            TotalRecordCount: 1,
          });
          return;
        }
        if (
          request.url === `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}` &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondJson(response, MOVIE_RESPONSE);
          return;
        }
        const itemResponse = TARGETED_ITEM_RESPONSE_BY_URL[request.url ?? ""];
        if (itemResponse !== undefined) {
          respondJson(response, itemResponse);
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
        if (request.url === `/jellyfin/Items/${STREAMING_UNAVAILABLE_MOVIE_ID}?userId=${USER_ID}`) {
          response.statusCode = HTTP_UNAVAILABLE;
          response.setHeader("content-type", "application/json");
          response.write(PROVIDER_ERROR_SENTINEL);
          failureBodyObserved.resolve();
          response.once("close", failureBodyCancellation.resolve);
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
        catalog,
        failureBodyCancellationObserved: failureBodyCancellation.promise,
        failureBodyObserved: failureBodyObserved.promise,
        hangingRequestObserved: hangingRequest.promise,
        requests,
        server,
      };
    },
  }),
  ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
);

const acquireConfiguredJellyfinPlugin = Effect.gen(function* acquireConfiguredJellyfinPlugin() {
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
  return { jellyfin, plugin, supervisor };
});

const superviseConfiguredJellyfin = (
  supervisor: PluginSupervisor["Service"],
  jellyfin: ControlledJellyfin,
  options: Readonly<{
    apiKey?: string;
    arguments?: readonly string[];
    providerInstanceId?: string;
    revision?: string;
  }> = {},
) =>
  supervisor.supervise(
    {
      arguments: [...(options.arguments ?? [JELLYFIN_PLUGIN_PATH])],
      executable: process.execPath,
      expectedProviderType: "jellyfin",
      stderrEvents: [],
    },
    {
      configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
      credentials: { api_key: options.apiKey ?? API_KEY },
      kind: "instance",
      providerInstanceId: options.providerInstanceId ?? "provider-instance",
      revision: options.revision ?? "revision-1",
    },
  );

const passthroughActivity = <Success, Failure, Requirements>(
  _providerInstanceId: string,
  activity: Effect.Effect<Success, Failure, Requirements>,
) => activity;

interface PersistedCatalogImport {
  readonly canonicalItemCount: number;
  readonly hasContinuation: boolean | null;
  readonly libraryEntryCount: number;
  readonly mappingCount: number;
  readonly nextRetryAt: Date | null;
  readonly safeFailureReason: string | null;
  readonly status: string | null;
}

const readPersistedCatalogImport = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async (): Promise<PersistedCatalogImport> => {
      const result = await pool.query<{
        readonly canonical_item_count: number;
        readonly has_continuation: boolean | null;
        readonly library_entry_count: number;
        readonly mapping_count: number;
        readonly next_retry_at: Date | null;
        readonly safe_failure_reason: string | null;
        readonly status: string | null;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM canonical_item) AS canonical_item_count,
           (SELECT last_accepted_continuation IS NOT NULL
              FROM provider_catalog_scan_state
              WHERE provider_instance_id = $1) AS has_continuation,
           (SELECT count(*)::integer FROM library_entry) AS library_entry_count,
           (SELECT count(*)::integer FROM provider_item_mapping
              WHERE provider_instance_id = $1) AS mapping_count,
           (SELECT next_retry_at FROM provider_catalog_scan_state
              WHERE provider_instance_id = $1) AS next_retry_at,
           (SELECT safe_failure_reason FROM provider_catalog_scan_state
              WHERE provider_instance_id = $1) AS safe_failure_reason,
           (SELECT status FROM provider_catalog_scan_state
              WHERE provider_instance_id = $1) AS status`,
        [CATALOG_PROVIDER_INSTANCE_ID],
      );
      const [row] = result.rows;
      if (row === undefined) {
        throw new Error("persisted catalog import snapshot is missing");
      }
      return {
        canonicalItemCount: row.canonical_item_count,
        hasContinuation: row.has_continuation,
        libraryEntryCount: row.library_entry_count,
        mappingCount: row.mapping_count,
        nextRetryAt: row.next_retry_at,
        safeFailureReason: row.safe_failure_reason,
        status: row.status,
      };
    }),
  );

interface PersistedCatalogPoll {
  readonly condition: (snapshot: PersistedCatalogImport) => boolean;
  readonly deadline: number;
  readonly description: string;
}

const pollPersistedCatalogImport = (
  databaseUrl: string,
  poll: PersistedCatalogPoll,
): Effect.Effect<PersistedCatalogImport> =>
  Effect.gen(function* persistedCatalogImportPoll() {
    const snapshot = yield* readPersistedCatalogImport(databaseUrl);
    if (poll.condition(snapshot)) {
      return snapshot;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= poll.deadline) {
      return yield* Effect.die(
        new Error(`catalog import did not ${poll.description}: ${JSON.stringify(snapshot)}`),
      );
    }
    yield* Effect.sleep(CATALOG_IMPORT_POLL_MILLISECONDS);
    return yield* pollPersistedCatalogImport(databaseUrl, poll);
  });

const waitForPersistedCatalogImport = (
  databaseUrl: string,
  condition: (snapshot: PersistedCatalogImport) => boolean,
  description: string,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      pollPersistedCatalogImport(databaseUrl, {
        condition,
        deadline: now + CATALOG_IMPORT_WAIT_MILLISECONDS,
        description,
      }),
    ),
  );

const readCanonicalStorage = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async (): Promise<string> => {
      const result = await pool.query<{ readonly stored_catalog: string }>(
        `SELECT jsonb_build_object(
           'items', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                       FROM canonical_item AS record),
           'library', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                         FROM library_entry AS record),
           'hierarchy', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                           FROM canonical_hierarchy AS record),
           'item_mappings', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                               FROM provider_item_mapping AS record),
           'external_ids', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                              FROM provider_external_identifier AS record),
           'artwork', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                         FROM canonical_artwork AS record),
           'credits', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                         FROM canonical_credit AS record),
           'sources', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                         FROM media_source AS record),
           'parts', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                       FROM media_part AS record),
           'tracks', (SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb)
                        FROM media_track AS record)
         )::text AS stored_catalog`,
      );
      const [row] = result.rows;
      const storedCatalog = row?.stored_catalog;
      if (storedCatalog === undefined) {
        throw new Error("canonical storage snapshot is missing");
      }
      return storedCatalog;
    }),
  );

const assertOpaqueArtworkReferences = (item: ProviderMediaItem): void => {
  for (const artwork of item.artwork) {
    expect(artwork.artworkReference?.artworkId).toMatch(OPAQUE_ARTWORK_REFERENCE);
  }
  for (const credit of item.credits) {
    if (credit.portraitArtworkReference !== undefined) {
      expect(credit.portraitArtworkReference.artworkId).toMatch(OPAQUE_ARTWORK_REFERENCE);
    }
  }
};

const assertNormalizedMetadata = (item: ProviderMediaItem) => {
  expect(item).toMatchObject({
    artwork: [
      {
        artworkReference: {
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.POSTER,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.BACKDROP,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.BACKDROP,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: MOVIE_ID },
        },
        role: ArtworkRole.LOGO,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
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
          itemReference: { itemId: "person-actor" },
        },
        role: MediaCreditRole.ACTOR,
      },
      {
        name: "Denis Villeneuve",
        portraitArtworkReference: {
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
  assertOpaqueArtworkReferences(item);
};
const assertNormalizedShow = (item: ProviderMediaItem) => {
  expect(item).toMatchObject({
    artwork: [
      {
        artworkReference: {
          itemReference: { itemId: SHOW_ID },
        },
        role: ArtworkRole.POSTER,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: SHOW_ID },
        },
        role: ArtworkRole.BACKDROP,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: SHOW_ID },
        },
        role: ArtworkRole.LOGO,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
    ],
    contentRating: "TV-MA",
    credits: [
      {
        characterName: "Jonas Kahnwald",
        name: "Louis Hofmann",
        role: MediaCreditRole.ACTOR,
      },
    ],
    externalIdentifiers: [
      { namespace: "imdb", value: "tt5753856" },
      { namespace: "tmdb", value: "70523" },
      { namespace: "tvdb", value: "334824" },
    ],
    genres: ["Crime", "Drama", "Mystery"],
    itemReference: { itemId: SHOW_ID },
    kind: MediaKind.SHOW,
    kindDetails: {
      case: "show",
      value: {
        episodeCount: 26,
        firstReleaseDate: { day: 1, month: 12, year: 2017 },
        lastReleaseDate: { day: 27, month: 6, year: 2020 },
        seasonCount: 3,
      },
    },
    originalTitle: "Dark",
    releaseYear: 2017,
    sources: [],
    studios: ["Wiedemann & Berg Television"],
    synopsis: "A missing child sets four families on a frantic hunt for answers.",
    tagline: "Everything is connected.",
    title: "Dark",
  });
  assertOpaqueArtworkReferences(item);
};
const assertNormalizedSeason = (item: ProviderMediaItem) => {
  expect(item).toMatchObject({
    artwork: [
      {
        artworkReference: {
          itemReference: { itemId: SEASON_ID },
        },
        role: ArtworkRole.POSTER,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
      {
        artworkReference: {
          itemReference: { itemId: SEASON_ID },
        },
        role: ArtworkRole.THUMBNAIL,
        textPresence: ArtworkTextPresence.UNKNOWN,
      },
    ],
    genres: ["Crime", "Drama"],
    itemReference: { itemId: SEASON_ID },
    kind: MediaKind.SEASON,
    kindDetails: {
      case: "season",
      value: {
        episodeCount: 8,
        seasonNumber: 2,
        showReference: { itemId: SHOW_ID },
      },
    },
    releaseYear: 2019,
    sources: [],
    studios: ["Wiedemann & Berg Television"],
    synopsis: "The families confront new truths across time.",
    title: "Season 2",
  });
  assertOpaqueArtworkReferences(item);
};

const assertNormalizedSources = (item: ProviderMediaItem, itemId = MOVIE_ID) => {
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
              itemReference: { itemId },
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
                    itemReference: { itemId },
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
                    itemReference: { itemId },
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
                    itemReference: { itemId },
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
        itemReference: { itemId },
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
              itemReference: { itemId },
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
                    itemReference: { itemId },
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
                    itemReference: { itemId },
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
        itemReference: { itemId },
        sourceId: "source-1080p",
      },
    },
  ]);
};

it.effect("resumes a complete normalized catalog scan after plugin replacement", () =>
  Effect.scoped(
    Effect.gen(function* jellyfinCatalogScanTest() {
      const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
      const first = yield* plugin.call(
        LibraryService.method.listItems,
        { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(first.complete).toBe(false);
      expect(first.consistency).toBe(ListConsistency.BEST_EFFORT_SCAN);
      expect(first.items).toHaveLength(CATALOG_PAGE_SIZE);
      const [movie, show] = first.items;
      if (movie === undefined || show === undefined || first.nextPageToken === undefined) {
        throw new Error("first Jellyfin catalog page was incomplete");
      }
      assertNormalizedMetadata(movie);
      assertNormalizedSources(movie);
      assertNormalizedShow(show);

      yield* TestClock.adjust(IDLE_RETIREMENT_MILLISECONDS);
      const second = yield* plugin.call(
        LibraryService.method.listItems,
        { scan: { case: "continuation", value: first.nextPageToken } },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(second.complete).toBe(false);
      expect(second.items).toHaveLength(SINGLE_ITEM_COUNT);
      const [season] = second.items;
      if (season === undefined || second.nextPageToken === undefined) {
        throw new Error("second Jellyfin catalog page was incomplete");
      }
      assertNormalizedSeason(season);

      const third = yield* plugin.call(
        LibraryService.method.listItems,
        { scan: { case: "continuation", value: second.nextPageToken } },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(third.complete).toBe(false);
      expect(third.items).toHaveLength(SINGLE_ITEM_COUNT);
      const [episode] = third.items;
      if (episode === undefined || third.nextPageToken === undefined) {
        throw new Error("third Jellyfin catalog page was incomplete");
      }
      assertNormalizedSources(episode, EPISODE_ID);

      const fourth = yield* plugin.call(
        LibraryService.method.listItems,
        { scan: { case: "continuation", value: third.nextPageToken } },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(fourth).toMatchObject({
        complete: false,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [],
      });
      if (fourth.nextPageToken === undefined) {
        throw new Error("fourth Jellyfin catalog page was incomplete");
      }

      const complete = yield* plugin.call(
        LibraryService.method.listItems,
        { scan: { case: "continuation", value: fourth.nextPageToken } },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(complete).toMatchObject({
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
        items: [],
      });
      expect(complete.nextPageToken).toBeUndefined();

      const catalogRequests = jellyfin.requests.map(({ authorization, url }) => {
        const endpoint = new URL(url, "http://jellyfin.invalid");
        return {
          authorization,
          pathname: endpoint.pathname,
          query: Object.fromEntries(endpoint.searchParams),
        };
      });
      expect(catalogRequests).toEqual(
        ["0", "2", "4", "6", "8"].map((startIndex) => ({
          authorization: `MediaBrowser Token="${API_KEY}"`,
          pathname: "/jellyfin/Items",
          query: {
            collapseBoxSetItems: "false",
            enableImages: "true",
            enableTotalRecordCount: "false",
            enableUserData: "false",
            fields:
              "ChildCount,Genres,MediaSources,MediaStreams,OriginalTitle,Overview,People,PlayAccess,ProviderIds,RecursiveItemCount,Studios,Taglines",
            imageTypeLimit: "20",
            includeItemTypes: "Movie,Series,Season,Episode",
            limit: String(CATALOG_PAGE_SIZE),
            recursive: "true",
            sortBy: "SortName",
            sortOrder: "Ascending",
            startIndex,
            userId: USER_ID,
          },
        })),
      );
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  ),
);

it.live(
  "persists and resumes a supervised production Jellyfin catalog scan",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.scoped(
        Effect.gen(function* persistedJellyfinCatalogImportTest() {
          yield* initializeCatalogDatabase(databaseUrl, [
            { id: CATALOG_PROVIDER_INSTANCE_ID, priority: 1 },
          ]);
          const jellyfin = yield* acquireControlledJellyfin;
          const supervisor = yield* PluginSupervisor;
          const outOfOrderResponses = [
            EPISODE_RESPONSE,
            EPISODE_RESPONSE,
            SEASON_RESPONSE,
            SHOW_RESPONSE,
            MOVIE_RESPONSE,
          ] as const;
          jellyfin.catalog.responses = Array.from(
            { length: CORE_CATALOG_PAGE_SIZE + SINGLE_ITEM_COUNT },
            (_value, index) => outOfOrderResponses[index % outOfOrderResponses.length],
          );
          jellyfin.catalog.hangAtStartIndex = CORE_CATALOG_PAGE_SIZE;

          const failedImport = yield* useDatabase(databaseUrl, productionMigrations, (database) => {
            let providerRevision = CATALOG_PROVIDER_REVISION;
            const providers = {
              ...database.providers,
              loadInstallation: () =>
                Effect.succeed({
                  capabilities: [PluginProviderCapability.LIBRARY_READ],
                  configurationSchema: {},
                  contractMajor: 1,
                  description: "Controlled production Jellyfin",
                  displayName: "Jellyfin",
                  pluginBuildVersion: "test",
                  providerTypeId: "jellyfin",
                  schemaProfileVersion: 1,
                  schemaRevision: "1",
                }),
              loadInstance: (providerInstanceId: string) => {
                if (providerInstanceId !== CATALOG_PROVIDER_INSTANCE_ID) {
                  return Effect.die(new Error("unexpected catalog provider instance"));
                }
                return Effect.succeed({
                  configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
                  credentials: { api_key: API_KEY },
                  displayName: "Controlled Jellyfin",
                  enabled: true,
                  id: CATALOG_PROVIDER_INSTANCE_ID,
                  providerTypeId: "jellyfin",
                  revision: providerRevision,
                  syncPriority: 1,
                });
              },
            };
            const listPage = listProviderCatalogPage(providers, supervisor);
            const makeImporter = (coreRunId: string) =>
              makeCatalogImport({
                catalog: database.catalog,
                coreRunId,
                listPage,
                loadArtworkAsset: () => Effect.succeed(NO_ARTWORK_ASSET),
                now: Date.now,
                random: () => NO_PROVIDER_REQUESTS,
                runProviderActivity: passthroughActivity,
              });
            const reportFatalFailure = (cause: unknown) => Effect.die(cause);

            return Effect.gen(function* exercisePersistedJellyfinCatalogImport() {
              yield* Effect.scoped(
                Effect.gen(function* interruptAfterFirstPage() {
                  yield* makeImporter("first-core-run").start(reportFatalFailure);
                  yield* waitForPersistedCatalogImport(
                    databaseUrl,
                    (snapshot) =>
                      snapshot.status === "running" && snapshot.hasContinuation === true,
                    "persist its first continuation",
                  );
                  yield* Effect.promise(() => jellyfin.hangingRequestObserved);
                }),
              );
              yield* Effect.promise(() => jellyfin.cancellationObserved);

              const interrupted = yield* readPersistedCatalogImport(databaseUrl);
              expect(interrupted).toMatchObject({
                canonicalItemCount: 4,
                hasContinuation: true,
                libraryEntryCount: 4,
                mappingCount: 4,
                status: "running",
              });
              expect(interrupted.safeFailureReason).toBeNull();

              jellyfin.catalog.hangAtStartIndex = undefined;
              yield* Effect.scoped(
                Effect.gen(function* resumePersistedContinuation() {
                  yield* makeImporter("resumed-core-run").start(reportFatalFailure);
                  yield* waitForPersistedCatalogImport(
                    databaseUrl,
                    (snapshot) => snapshot.status === "succeeded",
                    "complete its resumed pass",
                  );
                }),
              );

              const completed = yield* readPersistedCatalogImport(databaseUrl);
              expect(completed).toMatchObject({
                canonicalItemCount: 4,
                hasContinuation: false,
                libraryEntryCount: 4,
                mappingCount: 4,
                status: "succeeded",
              });
              expect(completed.safeFailureReason).toBeNull();

              providerRevision = `${CATALOG_PROVIDER_REVISION}-replacement`;
              yield* withPool(databaseUrl, (pool) =>
                Effect.promise(() =>
                  pool.query(
                    `UPDATE provider_instance
                       SET revision = $2, updated_at = transaction_timestamp()
                       WHERE id = $1`,
                    [CATALOG_PROVIDER_INSTANCE_ID, providerRevision],
                  ),
                ),
              );
              jellyfin.catalog.mode = "unavailable";
              yield* Effect.scoped(
                Effect.gen(function* persistSafeProviderFailure() {
                  yield* makeImporter("failure-core-run").start(reportFatalFailure);
                  yield* waitForPersistedCatalogImport(
                    databaseUrl,
                    (snapshot) =>
                      snapshot.status === "failed" &&
                      snapshot.safeFailureReason === "provider_unavailable",
                    "persist its safe provider failure",
                  );
                }),
              );
              return yield* readPersistedCatalogImport(databaseUrl);
            });
          });

          expect(failedImport).toMatchObject({
            canonicalItemCount: 4,
            libraryEntryCount: 4,
            mappingCount: 4,
            safeFailureReason: "provider_unavailable",
            status: "failed",
          });
          expect(failedImport.nextRetryAt).not.toBeNull();
          const storedCatalog = yield* readCanonicalStorage(databaseUrl);
          for (const sentinel of [API_KEY, PRIVATE_PATH, PROVIDER_ERROR_SENTINEL]) {
            expect(storedCatalog).not.toContain(sentinel);
            expect(JSON.stringify(failedImport)).not.toContain(sentinel);
          }
        }).pipe(Effect.provide(PluginSupervisor.layer())),
      ),
    ),
  CATALOG_IMPORT_PROCESS_TIMEOUT_MILLISECONDS,
);
it.live(
  "applies catalog page bounds and rejects an empty continuation before provider reads",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinCatalogPageBoundsTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
        const defaultPage = yield* plugin.call(
          LibraryService.method.listItems,
          { scan: { case: "begin", value: { pageSize: 0 } } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(defaultPage.complete).toBe(true);
        expect(defaultPage.items.map((item) => item.itemReference?.itemId)).toEqual([
          MOVIE_ID,
          SHOW_ID,
          SEASON_ID,
          EPISODE_ID,
        ]);

        const maximumPage = yield* plugin.call(
          LibraryService.method.listItems,
          { scan: { case: "begin", value: { pageSize: 100 } } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(maximumPage.complete).toBe(true);
        const excessivePageFailure = yield* plugin
          .call(
            LibraryService.method.listItems,
            { scan: { case: "begin", value: { pageSize: 101 } } },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(excessivePageFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.InvalidArgument,
        });
        const emptyContinuationFailure = yield* plugin
          .call(
            LibraryService.method.listItems,
            { scan: { case: "continuation", value: "" } },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(emptyContinuationFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.InvalidArgument,
        });
        expect(
          jellyfin.requests.map(({ url }) =>
            new URL(url, "http://jellyfin.invalid").searchParams.get("limit"),
          ),
        ).toEqual(["50", "100"]);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "rejects every invalid catalog continuation binding before provider reads",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinCatalogContinuationBindingTest() {
        const { jellyfin, plugin, supervisor } = yield* acquireConfiguredJellyfinPlugin;
        const expectRejectedLocally = (candidate: typeof plugin, continuation: string) =>
          Effect.gen(function* rejectedCatalogContinuationScenario() {
            const requestCount = jellyfin.requests.length;
            const failure = yield* candidate
              .call(
                LibraryService.method.listItems,
                { scan: { case: "continuation", value: continuation } },
                CALL_DEADLINE_MILLISECONDS,
              )
              .pipe(Effect.flip);
            expect(failure).toMatchObject({
              _tag: "PluginRpcError",
              code: Code.InvalidArgument,
            });
            expect(jellyfin.requests).toHaveLength(requestCount);
          });
        const expiredToken = yield* Effect.scoped(
          Effect.gen(function* expiredCatalogTokenScenario() {
            const expiredClockSupervisor = yield* PluginSupervisor;
            const expiredClockPlugin = yield* superviseConfiguredJellyfin(
              expiredClockSupervisor,
              jellyfin,
              {
                arguments: ["--import", EXPIRED_CLOCK_PRELOAD_URL, JELLYFIN_PLUGIN_PATH],
              },
            );
            const first = yield* expiredClockPlugin.call(
              LibraryService.method.listItems,
              { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
              CALL_DEADLINE_MILLISECONDS,
            );
            if (first.nextPageToken === undefined) {
              throw new Error("Expired Jellyfin catalog continuation was absent");
            }
            return first.nextPageToken;
          }).pipe(Effect.provide(PluginSupervisor.layer())),
        );
        yield* expectRejectedLocally(plugin, expiredToken);

        const first = yield* plugin.call(
          LibraryService.method.listItems,
          { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
          CALL_DEADLINE_MILLISECONDS,
        );
        const token = first.nextPageToken;
        if (token === undefined) {
          throw new Error("Jellyfin catalog continuation was absent");
        }
        let replacementCharacter = "A";
        if (token.startsWith(replacementCharacter)) {
          replacementCharacter = "B";
        }
        yield* expectRejectedLocally(
          plugin,
          `${replacementCharacter}${token.slice(FIRST_CODE_UNIT_LENGTH)}`,
        );

        const providerInstanceReplacement = yield* superviseConfiguredJellyfin(
          supervisor,
          jellyfin,
          { providerInstanceId: "different-provider-instance" },
        );
        yield* expectRejectedLocally(providerInstanceReplacement, token);

        const revisionReplacement = yield* superviseConfiguredJellyfin(supervisor, jellyfin, {
          revision: "revision-2",
        });
        yield* expectRejectedLocally(revisionReplacement, token);

        yield* Effect.scoped(
          Effect.gen(function* credentialReplacementScenario() {
            const credentialReplacementSupervisor = yield* PluginSupervisor;
            const credentialReplacement = yield* superviseConfiguredJellyfin(
              credentialReplacementSupervisor,
              jellyfin,
              { apiKey: "replacement-api-key" },
            );
            yield* expectRejectedLocally(credentialReplacement, token);
          }).pipe(Effect.provide(PluginSupervisor.layer())),
        );
        expect(jellyfin.requests).toHaveLength(CATALOG_CONTINUATION_PROVIDER_REQUEST_COUNT);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "returns safe visible failures for unsuccessful catalog scans",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinCatalogFailureTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
        const cases = [
          ["forbidden", Code.PermissionDenied],
          ["unavailable", Code.Unavailable],
          ["malformed_json", Code.Internal],
          ["malformed_item", Code.Internal],
          ["oversized", Code.Internal],
        ] as const;
        for (const [mode, code] of cases) {
          jellyfin.catalog.mode = mode;
          const failure = yield* plugin
            .call(
              LibraryService.method.listItems,
              { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
              CALL_DEADLINE_MILLISECONDS,
            )
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "PluginRpcError", code });
          if (mode === "unavailable") {
            expect(failure).toMatchObject({ retryAfterMilliseconds: 5000 });
          }
          const serializedFailure = JSON.stringify(failure);
          expect(serializedFailure).not.toContain(API_KEY);
          expect(serializedFailure).not.toContain(PRIVATE_PATH);
          expect(serializedFailure).not.toContain(PROVIDER_ERROR_SENTINEL);
        }

        jellyfin.catalog.mode = "canceled";
        const canceledCall = yield* Effect.forkChild(
          plugin.call(
            LibraryService.method.listItems,
            { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
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

it.live(
  "returns one normalized movie through the targeted library RPC",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinMovieObservationTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;

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
  "maps Jellyfin offline evidence to a provider-unavailable source",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinOfflineSourceTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;
        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: OFFLINE_MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(response.item?.sources).toHaveLength(SINGLE_ITEM_COUNT);
        expect(response.item?.sources).toMatchObject([
          {
            availability: SourceAvailability.PROVIDER_UNAVAILABLE,
            parts: [
              {
                partReference: {
                  partId: OFFLINE_SOURCE_ID,
                  sourceReference: {
                    itemReference: { itemId: OFFLINE_MOVIE_ID },
                    sourceId: OFFLINE_SOURCE_ID,
                  },
                },
                tracks: [],
              },
            ],
            sourceReference: {
              itemReference: { itemId: OFFLINE_MOVIE_ID },
              sourceId: OFFLINE_SOURCE_ID,
            },
          },
        ]);
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain(PRIVATE_PATH);
        expect(serialized).not.toContain(AUTHORIZED_URL);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain("Authorization");
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "maps a source without a supported delivery mode to unsupported",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinUnsupportedSourceTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;
        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: UNSUPPORTED_SOURCE_MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(response.item?.sources).toHaveLength(SINGLE_ITEM_COUNT);
        expect(response.item?.sources).toMatchObject([
          {
            availability: SourceAvailability.UNSUPPORTED,
            parts: [
              {
                partReference: {
                  partId: UNSUPPORTED_SOURCE_ID,
                  sourceReference: {
                    itemReference: { itemId: UNSUPPORTED_SOURCE_MOVIE_ID },
                    sourceId: UNSUPPORTED_SOURCE_ID,
                  },
                },
                tracks: [],
              },
            ],
            sourceReference: {
              itemReference: { itemId: UNSUPPORTED_SOURCE_MOVIE_ID },
              sourceId: UNSUPPORTED_SOURCE_ID,
            },
          },
        ]);
        const serialized = JSON.stringify(response);
        expect(serialized).not.toContain(PRIVATE_PATH);
        expect(serialized).not.toContain(AUTHORIZED_URL);
        expect(serialized).not.toContain(API_KEY);
        expect(serialized).not.toContain("Authorization");
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "returns normalized show details without inventing unavailable metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinShowObservationTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;

        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: SHOW_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        if (response.item === undefined) {
          throw new Error("Jellyfin show observation was absent");
        }
        assertNormalizedShow(response.item);

        const sparseResponse = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: SPARSE_SHOW_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(sparseResponse.item).toMatchObject({
          itemReference: { itemId: SPARSE_SHOW_ID },
          kind: MediaKind.SHOW,
          kindDetails: { case: "show", value: {} },
          sources: [],
          title: "Unknown schedule",
        });
        expect(sparseResponse.item?.releaseYear).toBeUndefined();
        expect(sparseResponse.item?.runtime).toBeUndefined();
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "returns a positive-numbered season with its opaque show reference",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinSeasonObservationTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;

        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: SEASON_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        if (response.item === undefined) {
          throw new Error("Jellyfin season observation was absent");
        }
        assertNormalizedSeason(response.item);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "returns a positive-numbered episode with complete hierarchy and sources",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinEpisodeObservationTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;

        const response = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: EPISODE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        if (response.item === undefined) {
          throw new Error("Jellyfin episode observation was absent");
        }
        expect(response.item).toMatchObject({
          artwork: [
            {
              artworkReference: {
                itemReference: { itemId: EPISODE_ID },
              },
              role: ArtworkRole.THUMBNAIL,
              textPresence: ArtworkTextPresence.UNKNOWN,
            },
          ],
          itemReference: { itemId: EPISODE_ID },
          kind: MediaKind.EPISODE,
          kindDetails: {
            case: "episode",
            value: {
              episodeNumber: 3,
              releaseDate: { day: 5, month: 7, year: 2019 },
              seasonNumber: 2,
              seasonReference: { itemId: SEASON_ID },
              showReference: { itemId: SHOW_ID },
            },
          },
          releaseYear: 2019,
          title: "An Endless Cycle",
        });
        assertOpaqueArtworkReferences(response.item);
        assertNormalizedSources(response.item, EPISODE_ID);
        const sparseResponse = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: SPARSE_EPISODE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(sparseResponse.item).toMatchObject({
          itemReference: { itemId: SPARSE_EPISODE_ID },
          kind: MediaKind.EPISODE,
          kindDetails: {
            case: "episode",
            value: {
              episodeNumber: 1,
              seasonNumber: 2,
              seasonReference: { itemId: SEASON_ID },
              showReference: { itemId: SHOW_ID },
            },
          },
          sources: [],
          title: "Unknown air date",
        });
        expect(sparseResponse.item?.kindDetails.value).not.toHaveProperty("releaseDate");
        expect(sparseResponse.item?.runtime).toBeUndefined();
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "accepts contract-valid internationalized references and metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinInternationalizedMovieTest() {
        const { plugin } = yield* acquireConfiguredJellyfinPlugin;

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
  "rejects an opaque reference that would escape the configured provider prefix",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinProviderPrefixConfinementTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
        const failure = yield* plugin
          .call(
            LibraryService.method.getItem,
            { itemReference: { itemId: PROVIDER_PREFIX_ESCAPE_ID } },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.Internal,
        });
        expect(jellyfin.requests).toHaveLength(NO_PROVIDER_REQUESTS);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "cancels a non-success provider response body through the library RPC",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinFailureBodyCancellationTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
        const failure = yield* plugin
          .call(
            LibraryService.method.getItem,
            { itemReference: { itemId: STREAMING_UNAVAILABLE_MOVIE_ID } },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.Unavailable,
        });
        yield* Effect.promise(() => jellyfin.failureBodyObserved);
        yield* Effect.promise(() => jellyfin.failureBodyCancellationObserved);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "returns safe outcomes for unsuccessful targeted item reads",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinItemFailureTest() {
        const { jellyfin, plugin } = yield* acquireConfiguredJellyfinPlugin;
        const cases = [
          [MISSING_MOVIE_ID, Code.NotFound],
          [FORBIDDEN_MOVIE_ID, Code.PermissionDenied],
          [UNAVAILABLE_MOVIE_ID, Code.Unavailable],
          [OVERSIZED_MOVIE_ID, Code.Internal],
          [MALFORMED_JSON_MOVIE_ID, Code.Internal],
          [MALFORMED_MOVIE_ID, Code.Internal],
          [MISSING_AVAILABILITY_MOVIE_ID, Code.Internal],
          [UNKNOWN_AVAILABILITY_MOVIE_ID, Code.Internal],
          [MALFORMED_DATE_MOVIE_ID, Code.Internal],
          [SPECIALS_SEASON_ID, Code.Unimplemented],
          [SPECIAL_EPISODE_ID, Code.Unimplemented],
          [MALFORMED_SHOW_ID, Code.Internal],
          [MALFORMED_SEASON_ID, Code.Internal],
          [MALFORMED_EPISODE_ID, Code.Internal],
          [ZERO_EPISODE_ID, Code.Internal],
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

it.live(
  "serves every public LibraryService method from a supervised production Jellyfin scan",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.scoped(
        Effect.gen(function* publicLibraryServiceJellyfinTest() {
          const providerItemSentinel = "provider-item-public-boundary-sentinel";
          const providerSourceSentinel = "provider-source-public-boundary-sentinel";
          const providerArtworkSentinel = "provider-artwork-public-boundary-sentinel";
          const providerTrackSentinel = 4_000_000_001;
          const principalId = "public-library-reader";
          const masterKey = `base64:${Buffer.alloc(
            PUBLIC_LIBRARY_MASTER_KEY_BYTES,
            PUBLIC_LIBRARY_MASTER_KEY_FILL,
          ).toString("base64")}`;
          const capturedLogRecords: unknown[] = [];
          yield* initializeCatalogDatabase(
            databaseUrl,
            [{ id: CATALOG_PROVIDER_INSTANCE_ID, priority: 1 }],
            true,
          );
          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query(
                `INSERT INTO provider_instance_observation (
                   instance_revision, provider_instance_id, status, summary
                 ) VALUES ($1, $2, 'healthy', 'healthy')`,
                [CATALOG_PROVIDER_REVISION, CATALOG_PROVIDER_INSTANCE_ID],
              ),
            ),
          );
          const jellyfin = yield* acquireControlledJellyfin;
          const supervisor = yield* PluginSupervisor;
          const boundaryMediaSources: unknown[] = [];
          for (const [sourceIndex, source] of MOVIE_RESPONSE.MediaSources.entries()) {
            let sourceId = source.Id;
            if (sourceIndex === FIRST_COLLECTION_INDEX) {
              sourceId = providerSourceSentinel;
            }
            const mediaStreams: unknown[] = [];
            for (const [trackIndex, track] of source.MediaStreams.entries()) {
              mediaStreams.push({
                ...track,
                Index:
                  providerTrackSentinel +
                  sourceIndex * PUBLIC_LIBRARY_PROVIDER_TRACK_STRIDE +
                  trackIndex,
              });
            }
            boundaryMediaSources.push({ ...source, Id: sourceId, MediaStreams: mediaStreams });
          }
          const boundaryMovie = {
            ...MOVIE_RESPONSE,
            Id: providerItemSentinel,
            ImageTags: {
              ...MOVIE_RESPONSE.ImageTags,
              Primary: providerArtworkSentinel,
            },
            MediaSources: boundaryMediaSources,
            PrivatePayload: PROVIDER_ERROR_SENTINEL,
          };
          jellyfin.catalog.responses = [
            EPISODE_RESPONSE,
            SEASON_RESPONSE,
            SHOW_RESPONSE,
            boundaryMovie,
          ];

          yield* useDatabase(databaseUrl, productionMigrations, (database) => {
            const providers = {
              ...database.providers,
              loadInstallation: () =>
                Effect.succeed({
                  capabilities: [
                    PluginProviderCapability.ARTWORK_RESOLVE,
                    PluginProviderCapability.LIBRARY_READ,
                  ],
                  configurationSchema: {},
                  contractMajor: 1,
                  description: "Controlled production Jellyfin",
                  displayName: "Jellyfin",
                  pluginBuildVersion: "test",
                  providerTypeId: "jellyfin",
                  schemaProfileVersion: 1,
                  schemaRevision: "1",
                }),
              loadInstance: (selectedProviderInstanceId: string) => {
                if (selectedProviderInstanceId !== CATALOG_PROVIDER_INSTANCE_ID) {
                  return Effect.die(new Error("unexpected catalog provider instance"));
                }
                return Effect.succeed({
                  configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
                  credentials: { api_key: API_KEY },
                  displayName: "Controlled Jellyfin",
                  enabled: true,
                  id: CATALOG_PROVIDER_INSTANCE_ID,
                  providerTypeId: "jellyfin",
                  revision: CATALOG_PROVIDER_REVISION,
                  syncPriority: 1,
                });
              },
            };
            const catalogDatabase = Database.of({ ...database, providers });
            const providerManagement = Object.freeze({
              createProviderInstance: () => Effect.die("unexpected provider creation"),
              deleteProviderInstance: () => Effect.die("unexpected provider deletion"),
              getProviderInstance: () => Effect.die("unexpected provider read"),
              listProviderInstances: () => Effect.die("unexpected provider list"),
              listProviderTypes: () => Effect.die("unexpected provider type list"),
              runProviderActivity: passthroughActivity,
              testProviderConfiguration: () => Effect.die("unexpected provider configuration test"),
              testProviderInstance: () => Effect.die("unexpected provider instance test"),
              updateProviderInstance: () => Effect.die("unexpected provider update"),
            });
            const authentication: AuthenticationService = Object.freeze({
              approveDeviceAuthorization: () =>
                Effect.die("unexpected device authorization approval"),
              consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
              consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
              resolveAdministrator: () => Effect.die("unexpected administrator resolution"),
              resolveConsumerPrincipal: (_authorization: string, scope: string) => {
                expect(scope).toBe("nama:library");
                return Effect.succeed({ id: principalId });
              },
              resolvePrincipal: () => Effect.die("unexpected principal resolution"),
              revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
              signIn: () => Effect.die("unexpected sign-in"),
              signOut: () => Effect.die("unexpected sign-out"),
            });

            return Effect.gen(function* exercisePublicStoredLibrary() {
              const importCatalog = makeCatalogImport({
                catalog: database.catalog,
                coreRunId: "public-library-core-run",
                listPage: listProviderCatalogPage(providers, supervisor),
                loadArtworkAsset: makeArtworkAssetLoader(
                  makeCatalogArtworkLeaseResolver(catalogDatabase, supervisor),
                  providerManagement.runProviderActivity,
                ),
                now: Date.now,
                random: () => NO_PROVIDER_REQUESTS,
                runProviderActivity: passthroughActivity,
              });
              yield* Effect.scoped(
                Effect.gen(function* completeCatalogImport() {
                  yield* importCatalog.start((cause) => Effect.die(cause));
                  yield* waitForPersistedCatalogImport(
                    databaseUrl,
                    (snapshot) => snapshot.status === "succeeded",
                    "complete the public Library catalog pass",
                  );
                }),
              );
              const catalogRequests = jellyfin.requests
                .filter(({ url }) => url.startsWith("/jellyfin/Items?"))
                .map(({ url }) => url);
              const providerRequestCount = jellyfin.requests.length;
              const artworkAccess: ArtworkAccessService = {
                locator: ({ height, width }) => ({
                  $typeName: "nama.api.v1.ArtworkLocator",
                  accessExpiresAt: undefined,
                  allowedRedirectOrigins: ["https://nama.example"],
                  headers: [],
                  height,
                  refreshAt: undefined,
                  url: "https://nama.example/artwork/opaque-token",
                  width,
                }),
                read: () => Effect.die("unexpected artwork byte read"),
              };
              const catalogQuery = CatalogQuery.of(
                yield* makeCatalogQuery({
                  artworkAccess,
                  catalog: database.catalogQueries,
                  masterKey,
                  now: Date.now,
                }),
              );
              const server = yield* startServer(catalogDatabase, {
                authentication,
                catalogQuery,
                records: capturedLogRecords,
              });
              const client = createClient(
                PublicLibraryService,
                createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
              );
              const options = {
                headers: { authorization: "Bearer public-library-session" },
              } as const;

              const home = yield* Effect.promise(() =>
                client.getHome({ sectionSize: 10 }, options),
              );
              const libraryFirst = yield* Effect.promise(() =>
                client.listLibrary(
                  {
                    filter: { watchFilter: WatchFilter.ANY },
                    pageSize: 1,
                    sort: LibrarySort.DATE_ADDED_DESC,
                  },
                  options,
                ),
              );
              expect(libraryFirst.nextPageToken).not.toBe("");
              const librarySecond = yield* Effect.promise(() =>
                client.listLibrary(
                  {
                    filter: { watchFilter: WatchFilter.ANY },
                    pageSize: 1,
                    pageToken: libraryFirst.nextPageToken,
                    sort: LibrarySort.DATE_ADDED_DESC,
                  },
                  options,
                ),
              );
              const search = yield* Effect.promise(() =>
                client.search({ pageSize: 10, query: "arrival" }, options),
              );
              const summaries = home.sections.flatMap((section) => section.items);
              const movieSummary = summaries.find(
                (summary) => summary.kind === PublicMediaKind.MOVIE,
              );
              const showSummary = summaries.find(
                (summary) => summary.kind === PublicMediaKind.SHOW,
              );
              if (movieSummary === undefined || showSummary === undefined) {
                throw new Error("stored Home is missing Movies or Shows");
              }
              expect(home.sections.map(({ kind }) => kind)).toEqual([
                HomeSectionKind.MOVIES,
                HomeSectionKind.SHOWS,
              ]);
              expect(movieSummary.playability).toBe(PublicPlayability.PLAYABLE);
              const media = yield* Effect.promise(() =>
                client.getMedia({ mediaId: movieSummary.id }, options),
              );
              const children = yield* Effect.promise(() =>
                client.listChildren({ pageSize: 10, parentMediaId: showSummary.id }, options),
              );
              const sourceSummary = media.media?.sourceSummaries[FIRST_COLLECTION_INDEX];
              const artwork = media.media?.artwork[FIRST_COLLECTION_INDEX];
              if (sourceSummary === undefined || artwork === undefined) {
                throw new Error("stored movie is missing source or artwork projections");
              }
              const source = yield* Effect.promise(() =>
                client.getMediaSource(
                  { mediaId: movieSummary.id, sourceId: sourceSummary.id },
                  options,
                ),
              );
              const resolvedArtwork = yield* Effect.promise(() =>
                client.resolveArtwork(
                  { artworkId: artwork.id, maxHeight: 1080, maxWidth: 1920 },
                  options,
                ),
              );

              expect(search.items.map(({ title }) => title)).toContain("Arrival");
              expect(children.items.map(({ title }) => title)).toEqual(["Season 2"]);
              expect(source.source?.mediaId).toBe(movieSummary.id);
              expect(resolvedArtwork.locator?.url).toBe(
                "https://nama.example/artwork/opaque-token",
              );
              expect(jellyfin.requests.map(({ url }) => url)).toContain(
                `/jellyfin/Items/${providerItemSentinel}/Images/Primary/0?maxWidth=1920&maxHeight=1920`,
              );
              expect(
                jellyfin.requests
                  .filter(({ url }) => url.startsWith("/jellyfin/Items?"))
                  .map(({ url }) => url),
              ).toEqual(catalogRequests);
              expect(jellyfin.requests).toHaveLength(providerRequestCount);
              const ordinaryPublicBoundary = {
                capturedLogRecords,
                children,
                home,
                libraryFirst,
                librarySecond,
                media,
                resolvedArtwork,
                search,
                source,
              };
              const ordinaryPublicContents = publicBoundaryJson(ordinaryPublicBoundary);
              for (const sentinel of [
                API_KEY,
                PRIVATE_PATH,
                PROVIDER_ERROR_SENTINEL,
                providerArtworkSentinel,
                providerItemSentinel,
                providerSourceSentinel,
              ]) {
                expect(ordinaryPublicContents).not.toContain(sentinel);
              }
              const publicReferenceValues = new Set<string>();
              collectPublicReferenceValues(ordinaryPublicBoundary, publicReferenceValues);
              expect(publicReferenceValues).not.toContain(String(providerTrackSentinel));
              expect(publicBoundaryJson(capturedLogRecords)).not.toContain(
                `"Index":${providerTrackSentinel}`,
              );
            });
          });
        }).pipe(Effect.provide(PluginSupervisor.layer())),
      ),
    ),
  CATALOG_IMPORT_PROCESS_TIMEOUT_MILLISECONDS,
);
