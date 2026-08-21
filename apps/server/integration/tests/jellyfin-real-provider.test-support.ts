import { setTimeout as sleep } from "node:timers/promises";

import {
  expectJellyfinResponseStatus as expectResponseStatus,
  jellyfinJsonObjectArrayResponse as jsonObjectArrayResponse,
  jellyfinJsonObjects,
  jellyfinJsonObjectResponse as jsonObjectResponse,
} from "./jellyfin-http.test-support.ts";

const EMPTY_LENGTH = 0;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const MEDIA_SCAN_ATTEMPTS = 60;
const MEDIA_SCAN_INTERVAL_MILLISECONDS = 250;
const LAST_ATTEMPT = 1;
const MOVIE_LIBRARY_NAME = "Nama Proof Movies";
const SHOW_LIBRARY_NAME = "Nama Proof Shows";
const MOVIE_TITLE = "Nama Proof Movie (2026)";
const EPISODE_TITLE = "Nama Proof Show S01E02";
const EXPECTED_EPISODE_NUMBER = 2;
const EXPECTED_SEASON_NUMBER = 1;
const MOVIE_LIBRARY = {
  collectionType: "movies",
  name: MOVIE_LIBRARY_NAME,
  path: "/media/movies",
} as const;
const SHOW_LIBRARY = {
  collectionType: "tvshows",
  name: SHOW_LIBRARY_NAME,
  path: "/media/shows",
} as const;

interface MediaPoll {
  readonly attemptsRemaining: number;
  readonly authorization: string;
  readonly baseUrl: string;
  readonly userId: string;
}

const addLibrary = async (
  baseUrl: string,
  authorization: string,
  library: typeof MOVIE_LIBRARY | typeof SHOW_LIBRARY,
): Promise<void> => {
  const url = new URL("Library/VirtualFolders", baseUrl);
  url.searchParams.set("name", library.name);
  url.searchParams.set("collectionType", library.collectionType);
  url.searchParams.set("paths", library.path);
  url.searchParams.set("refreshLibrary", "false");
  const response = await fetch(url, {
    body: JSON.stringify({
      LibraryOptions: {
        EnableChapterImageExtraction: false,
        EnableLUFSScan: false,
        EnableRealtimeMonitor: false,
        EnableTrickplayImageExtraction: false,
        ExtractChapterImagesDuringLibraryScan: false,
        ExtractTrickplayImagesDuringLibraryScan: false,
        SaveLocalMetadata: false,
      },
    }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  expectResponseStatus(response, HTTP_NO_CONTENT);
};

const addMissingLibraries = async (baseUrl: string, authorization: string): Promise<void> => {
  const virtualFolders = await jsonObjectArrayResponse(
    await fetch(new URL("Library/VirtualFolders", baseUrl), {
      headers: { authorization },
    }),
    HTTP_OK,
  );
  const existingNames = new Set(virtualFolders.map((folder) => folder["Name"]));
  if (!existingNames.has(MOVIE_LIBRARY.name)) {
    await addLibrary(baseUrl, authorization, MOVIE_LIBRARY);
  }
  if (!existingNames.has(SHOW_LIBRARY.name)) {
    await addLibrary(baseUrl, authorization, SHOW_LIBRARY);
  }
};

const readMediaItems = async (
  baseUrl: string,
  authorization: string,
  userId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> => {
  const url = new URL("Items", baseUrl);
  url.search = new URLSearchParams({
    fields: "MediaSources,MediaStreams",
    includeItemTypes: "Movie,Episode",
    recursive: "true",
    userId,
  }).toString();
  const response = await jsonObjectResponse(
    await fetch(url, { headers: { authorization } }),
    HTTP_OK,
  );
  return jellyfinJsonObjects(response["Items"], "expected the Jellyfin media items");
};

const primaryImageTag = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!("Primary" in value)) {
    return undefined;
  }
  return value.Primary;
};

const movieFixtureReady = (item: Readonly<Record<string, unknown>>): boolean => {
  const sources = item["MediaSources"];
  return [
    item["Name"] === MOVIE_TITLE,
    item["Type"] === "Movie",
    Array.isArray(sources),
    Array.isArray(sources) && sources.length > EMPTY_LENGTH,
    typeof primaryImageTag(item["ImageTags"]) === "string",
  ].every(Boolean);
};

const episodeFixtureReady = (item: Readonly<Record<string, unknown>>): boolean => {
  const sources = item["MediaSources"];
  return [
    item["IndexNumber"] === EXPECTED_EPISODE_NUMBER,
    item["Name"] === EPISODE_TITLE,
    item["ParentIndexNumber"] === EXPECTED_SEASON_NUMBER,
    item["Type"] === "Episode",
    Array.isArray(sources),
    Array.isArray(sources) && sources.length > EMPTY_LENGTH,
    typeof item["SeriesId"] === "string",
    typeof item["SeasonId"] === "string",
  ].every(Boolean);
};

const representativeMediaReady = (items: readonly Readonly<Record<string, unknown>>[]): boolean =>
  items.some((item) => movieFixtureReady(item)) && items.some((item) => episodeFixtureReady(item));

const waitForRepresentativeMedia = async ({
  attemptsRemaining,
  authorization,
  baseUrl,
  userId,
}: MediaPoll): Promise<void> => {
  const items = await readMediaItems(baseUrl, authorization, userId);
  if (representativeMediaReady(items)) {
    return;
  }
  if (attemptsRemaining === LAST_ATTEMPT) {
    throw new Error("Jellyfin did not scan the representative media fixture");
  }
  await sleep(MEDIA_SCAN_INTERVAL_MILLISECONDS);
  return waitForRepresentativeMedia({
    attemptsRemaining: attemptsRemaining - LAST_ATTEMPT,
    authorization,
    baseUrl,
    userId,
  });
};

const ensureRepresentativeMedia = async (
  baseUrl: string,
  authorization: string,
  userId: string,
): Promise<void> => {
  await addMissingLibraries(baseUrl, authorization);
  const refreshResponse = await fetch(new URL("Library/Refresh", baseUrl), {
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  expectResponseStatus(refreshResponse, HTTP_NO_CONTENT);
  await waitForRepresentativeMedia({
    attemptsRemaining: MEDIA_SCAN_ATTEMPTS,
    authorization,
    baseUrl,
    userId,
  });
};

export { ensureRepresentativeMedia };
