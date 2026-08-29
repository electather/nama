import { expect, it } from "@effect/vitest";
import type { ArtworkLocator } from "@nama/api/nama/api/v1/media_pb.js";
import { Effect } from "effect";

import { unusedCatalogQueries } from "../../database/tests/catalog-persistence.test-support.ts";
import type { ArtworkAccessService } from "../catalog-artwork-access.ts";
import { makeArtworkAccess } from "../catalog-artwork-access.ts";

const ZERO = 0;
const LAST_CHARACTER_OFFSET = -1;
const MASTER_KEY_BYTES = 32;
const MASTER_KEY_FILL = 67;
const ACCESS_LIFETIME_MILLISECONDS = 600_000;
const MASTER_KEY = `base64:${Buffer.alloc(MASTER_KEY_BYTES, MASTER_KEY_FILL).toString("base64")}`;
const NOW = new Date("2026-08-29T12:00:00.000Z").getTime();
const ARTWORK_ID = "2d469924-40f9-4a10-a4d0-4bdaa7bd88f0";
const ASSET_BYTES = Buffer.from("canonical-artwork", "utf8");

interface ArtworkAccessFixture {
  readonly access: ArtworkAccessService & { readonly close: () => void };
  readonly requestedIds: string[];
}

const makeArtworkAccessFixture = async (): Promise<ArtworkAccessFixture> => {
  const requestedIds: string[] = [];
  const access = await makeArtworkAccess({
    catalog: {
      ...unusedCatalogQueries,
      getArtworkTarget: (artworkId) => {
        requestedIds.push(artworkId);
        return Promise.resolve({
          assetBytes: ASSET_BYTES,
          assetMimeType: "image/jpeg",
          height: 900,
          width: 600,
        });
      },
    },
    masterKey: MASTER_KEY,
    publicUrl: "https://nama.example/",
  });
  return { access, requestedIds };
};

const tokenFromLocator = (locator: ArtworkLocator): string => {
  const url = new URL(locator.url);
  expect(url.origin).toBe("https://nama.example");
  expect(locator.allowedRedirectOrigins).toEqual(["https://nama.example"]);
  expect(locator.headers).toEqual([]);
  expect(locator.accessExpiresAt).toBeDefined();
  return url.pathname.slice("/artwork/".length);
};

const locatorFrom = (access: ArtworkAccessService): ArtworkLocator =>
  access.locator({ artworkId: ARTWORK_ID, height: 900, now: NOW, width: 600 });

const tamperedToken = (token: string): string => {
  let replacement = "A";
  if (token.endsWith(replacement)) {
    replacement = "B";
  }
  return `${token.slice(ZERO, LAST_CHARACTER_OFFSET)}${replacement}`;
};

it.effect("serves a persisted asset through an unexpired Nama artwork token", () =>
  Effect.gen(function* validArtworkAccessTest() {
    const { access, requestedIds } = yield* Effect.promise(makeArtworkAccessFixture);
    const asset = yield* access.read(tokenFromLocator(locatorFrom(access)), NOW);
    expect(asset).toEqual({ bytes: ASSET_BYTES, mimeType: "image/jpeg" });
    expect(requestedIds).toEqual([ARTWORK_ID]);
    access.close();
  }),
);

it.effect("rejects a tampered Nama artwork token", () =>
  Effect.gen(function* tamperedArtworkAccessTest() {
    const { access, requestedIds } = yield* Effect.promise(makeArtworkAccessFixture);
    const token = tamperedToken(tokenFromLocator(locatorFrom(access)));
    const failure = yield* access.read(token, NOW).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "ArtworkAccessNotFound" });
    expect(requestedIds).toEqual([]);
    access.close();
  }),
);

it.effect("rejects an expired Nama artwork token", () =>
  Effect.gen(function* expiredArtworkAccessTest() {
    const { access, requestedIds } = yield* Effect.promise(makeArtworkAccessFixture);
    const token = tokenFromLocator(locatorFrom(access));
    const failure = yield* access.read(token, NOW + ACCESS_LIFETIME_MILLISECONDS).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "ArtworkAccessNotFound" });
    expect(requestedIds).toEqual([]);
    access.close();
  }),
);
