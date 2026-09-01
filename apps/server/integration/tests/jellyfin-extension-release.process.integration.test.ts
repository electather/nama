import { setTimeout as sleep } from "node:timers/promises";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { restartJellyfin } from "./jellyfin-extension-restart.test-support.ts";
import {
  expectJellyfinResponseStatus,
  jellyfinJsonObjectResponse,
  jellyfinJsonObjects,
} from "./jellyfin-http.test-support.ts";
import { provisionReleaseJellyfin, requiredString } from "./provider-durable-loop.test-support.ts";
import type { JellyfinFixture } from "./provider-durable-loop.test-support.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const RESTART_SETTLE_MILLISECONDS = 5000;
const TEST_TIMEOUT_MILLISECONDS = 180_000;
const EMPTY_LENGTH = 0;

interface ReleaseMediaIdentity {
  readonly itemId: string;
  readonly sourceId: string;
}

interface ReleasePlaybackLease {
  readonly header: string;
  readonly resourceUrl: URL;
}

const requiredNumber = (record: Readonly<Record<string, unknown>>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`expected ${key} integer`);
  }
  return value;
};

const apiKeyAuthorization = (apiKey: string): string => `MediaBrowser Token="${apiKey}"`;

const verifyReleaseAuthentication = async (fixture: JellyfinFixture): Promise<void> => {
  const ordinaryHandshake = await fetch(new URL("Nama/v1/handshake", fixture.baseUrl), {
    headers: { authorization: apiKeyAuthorization(fixture.administratorAccessToken) },
    redirect: "manual",
  });
  expectJellyfinResponseStatus(ordinaryHandshake, HTTP_FORBIDDEN);

  const handshake = await jellyfinJsonObjectResponse(
    await fetch(new URL("Nama/v1/handshake", fixture.baseUrl), {
      headers: { authorization: apiKeyAuthorization(fixture.primaryApiKey) },
      redirect: "manual",
    }),
    HTTP_OK,
  );
  expect(handshake).toMatchObject({
    extension_version: "1.0.0",
    protocol: "nama.jellyfin.extension",
    protocol_version: 2,
  });
  expect(handshake["capabilities"]).toEqual(
    expect.arrayContaining(["direct_progressive", "playback_telemetry", "coherent_progress"]),
  );
};

const releaseMediaItems = async (
  fixture: JellyfinFixture,
): Promise<readonly Record<string, unknown>[]> => {
  const itemsUrl = new URL("Items", fixture.baseUrl);
  itemsUrl.search = new URLSearchParams({
    fields: "MediaSources,MediaStreams",
    includeItemTypes: "Movie",
    recursive: "true",
    userId: fixture.primaryUserId,
  }).toString();
  const response = await fetch(itemsUrl, {
    headers: { authorization: apiKeyAuthorization(fixture.primaryApiKey) },
  });
  const body = await jellyfinJsonObjectResponse(response, HTTP_OK);
  return jellyfinJsonObjects(body["Items"], "expected Release-fixture media items");
};

const releaseMediaIdentity = async (fixture: JellyfinFixture): Promise<ReleaseMediaIdentity> => {
  const items = await releaseMediaItems(fixture);
  const movie = items.find((item) => item["Name"] === "Nama Proof Movie (2026)");
  if (movie === undefined) {
    throw new Error("Release fixture movie was absent");
  }
  const sources = jellyfinJsonObjects(movie["MediaSources"], "expected Release media sources");
  const [source] = sources;
  if (source === undefined) {
    throw new Error("Release fixture source was absent");
  }
  return { itemId: requiredString(movie, "Id"), sourceId: requiredString(source, "Id") };
};

const planReleasePlayback = async (
  fixture: JellyfinFixture,
  media: ReleaseMediaIdentity,
  privateHeaders: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> => {
  const planRequest = {
    capabilities: {
      direct_play_profiles: [{ audio_codecs: ["aac"], container: "mp4", video_codec: "h264" }],
      dynamic_ranges: ["sdr"],
      protocols: ["http_progressive"],
      subtitle_capabilities: [],
    },
    item_id: media.itemId,
    preferences: {
      preferred_audio_languages: [],
      preferred_subtitle_languages: [],
      quality: "auto",
      subtitle_preference: "auto",
    },
    source_id: media.sourceId,
    start_position: { nanos: 0, seconds: "0" },
    user_id: fixture.primaryUserId,
  };
  const response = await fetch(new URL("Nama/v1/playback/plans", fixture.baseUrl), {
    body: JSON.stringify(planRequest),
    headers: privateHeaders,
    method: "POST",
    redirect: "manual",
  });
  return jellyfinJsonObjectResponse(response, HTTP_OK);
};

const openReleaseSession = async (
  fixture: JellyfinFixture,
  plan: Readonly<Record<string, unknown>>,
  privateHeaders: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> => {
  const audioTrackIndex = requiredNumber(plan, "default_audio_track_index");
  const planId = requiredString(plan, "plan_id");
  const response = await fetch(new URL("Nama/v1/playback/sessions", fixture.baseUrl), {
    body: JSON.stringify({
      audio_track_index: audioTrackIndex,
      operation_id: "release-artifact-open",
      plan_id: planId,
      subtitle_disabled: true,
    }),
    headers: privateHeaders,
    method: "POST",
    redirect: "manual",
  });
  return jellyfinJsonObjectResponse(response, HTTP_OK);
};

const releasePlaybackLease = (
  opened: Readonly<Record<string, unknown>>,
  baseUrl: string,
): ReleasePlaybackLease => {
  const mediaResource = requiredString(opened, "media_resource");
  return {
    header: requiredString(opened, "lease"),
    resourceUrl: new URL(`Nama/v1/playback/${encodeURIComponent(mediaResource)}`, baseUrl),
  };
};

const verifyMediaResource = async (lease: ReleasePlaybackLease): Promise<void> => {
  const response = await fetch(lease.resourceUrl, {
    headers: { "x-nama-playback-lease": lease.header },
    redirect: "manual",
  });
  expectJellyfinResponseStatus(response, HTTP_OK);
  const body = await response.arrayBuffer();
  expect(body.byteLength).toBeGreaterThan(EMPTY_LENGTH);
};

const openReleasePlayback = async (fixture: JellyfinFixture): Promise<ReleasePlaybackLease> => {
  const media = await releaseMediaIdentity(fixture);
  const privateHeaders = {
    authorization: apiKeyAuthorization(fixture.primaryApiKey),
    "content-type": "application/json",
  };
  const plan = await planReleasePlayback(fixture, media, privateHeaders);
  const opened = await openReleaseSession(fixture, plan, privateHeaders);
  const lease = releasePlaybackLease(opened, fixture.baseUrl);
  await verifyMediaResource(lease);
  return lease;
};

const verifyReleaseRestart = async (
  fixture: JellyfinFixture,
  lease: ReleasePlaybackLease,
): Promise<void> => {
  const restartedBaseUrl = await restartJellyfin("jellyfin-release");
  await sleep(RESTART_SETTLE_MILLISECONDS);
  const handshake = await fetch(new URL("Nama/v1/handshake", restartedBaseUrl), {
    headers: { authorization: apiKeyAuthorization(fixture.primaryApiKey) },
    redirect: "manual",
  });
  expectJellyfinResponseStatus(handshake, HTTP_OK);
  const restartedResource = new URL(lease.resourceUrl.pathname, restartedBaseUrl);
  await verifyMediaResource({ header: lease.header, resourceUrl: restartedResource });
};

it.live(
  "loads the packaged Release extension and retains its scoped key across restart",
  () =>
    Effect.gen(function* releaseArtifactProof() {
      const fixture = yield* provisionReleaseJellyfin;
      yield* Effect.promise(() => verifyReleaseAuthentication(fixture));
      const lease = yield* Effect.promise(() => openReleasePlayback(fixture));
      yield* Effect.promise(() => verifyReleaseRestart(fixture, lease));
    }),
  TEST_TIMEOUT_MILLISECONDS,
);
