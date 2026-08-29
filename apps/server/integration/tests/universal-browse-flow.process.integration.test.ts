// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, import/max-dependencies -- The real-process acceptance keeps OAuth authorization and every generated browse call in one ordered boundary proof.
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import {
  HomeSectionKind,
  LibraryService,
  LibrarySort,
  WatchFilter,
} from "@nama/api/nama/api/v1/library_pb.js";
import { ArtworkRole, MediaKind } from "@nama/api/nama/api/v1/media_pb.js";
import { Clock, Effect } from "effect";

import {
  completeAdministratorSetup,
  signInAdministrator,
  startAuthenticationFlow,
} from "./authentication-flow.test-support.ts";
import type { AuthenticationFlow } from "./authentication-flow.test-support.ts";
import { stopCleanly } from "./authentication-process.test-support.ts";
import {
  cliEnvironment,
  createNamaRunner,
  providerInstanceFromNama,
  withNamaBinary,
} from "./compiled-cli.test-support.ts";
import type { NamaRunner } from "./compiled-cli.test-support.ts";
import { withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { provisionJellyfin, requiredString } from "./provider-durable-loop.test-support.ts";
import type { JellyfinFixture } from "./provider-durable-loop.test-support.ts";

const TEST_TIMEOUT_MILLISECONDS = 120_000;
const CATALOG_IMPORT_WAIT_MILLISECONDS = 30_000;
const CATALOG_IMPORT_POLL_MILLISECONDS = 100;
const APPLE_CLIENT_ID = "nama-apple";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const AUTHORIZATION_SCOPE = "nama:library nama:playback nama:user-state offline_access";
const ADMINISTRATOR_EMAIL = "administrator@universal-browse.test";
const ADMINISTRATOR_PASSWORD = "administrator-password-for-universal-browse";
const PROVIDER_TYPE_ID = "jellyfin";
const PROVIDER_OPERATION_ID = "universal-browse-provider";
const EXPECTED_CANONICAL_KIND_COUNT = 4;
const HTTP_OK = 200;
const EMPTY_LENGTH = 0;
const FIRST_INDEX = 0;
const SINGLE_ITEM_PAGE_SIZE = 1;
const JWT_SEGMENT_COUNT = 3;
const HOME_SECTION_SIZE = 10;
const SEARCH_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MILLISECONDS = 5000;
const ARTWORK_MAX_HEIGHT = 1080;
const ARTWORK_MAX_WIDTH = 1920;

interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
}

interface TokenResponse {
  readonly access_token: string;
}

interface ProtectedResourceMetadata {
  readonly resource: string;
}

interface CatalogImportSnapshot {
  readonly canonicalItemCount: number;
  readonly libraryEntryCount: number;
  readonly status: string | null;
}
interface ObservedProviderRequest {
  readonly method: string;
  readonly url: string;
}

interface JellyfinProxy {
  readonly baseUrl: string;
  readonly providerReferences: ReadonlySet<string>;
  readonly requests: readonly ObservedProviderRequest[];
  readonly server: Server;
}
interface JellyfinForwardInput {
  readonly jellyfin: JellyfinFixture;
  readonly providerReferences: Set<string>;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

interface BrowseFlowInput {
  readonly accessToken: string;
  readonly flow: AuthenticationFlow;
  readonly jellyfin: JellyfinFixture;
  readonly providerRequestCount: number;
  readonly proxy: JellyfinProxy;
}

const PRIVATE_REFERENCE_KEYS: Readonly<Record<string, true>> = {
  BackdropImageTags: true,
  Id: true,
  Path: true,
  Primary: true,
};
const HTTP_BAD_GATEWAY = 502;
const EPHEMERAL_PORT = 0;

const collectProviderReferences = (value: unknown, references: Set<string>, key = ""): void => {
  if (typeof value === "string") {
    if (Object.hasOwn(PRIVATE_REFERENCE_KEYS, key) && value.length > EMPTY_LENGTH) {
      references.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProviderReferences(item, references, key);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [property, nested] of Object.entries(value)) {
    collectProviderReferences(nested, references, property);
  }
};

const proxyRequestHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (value !== undefined) {
      headers.set(name, value.join(", "));
    }
  }
  headers.delete("accept-encoding");
  headers.delete("content-length");
  headers.delete("host");
  return headers;
};

const forwardJellyfinRequest = async ({
  jellyfin,
  providerReferences,
  request,
  response,
}: JellyfinForwardInput): Promise<void> => {
  try {
    const requestUrl = request.url ?? "/";
    const method = request.method ?? "GET";
    const upstream = await fetch(new URL(requestUrl, jellyfin.baseUrl), {
      headers: proxyRequestHeaders(request),
      method,
      redirect: "manual",
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers.entries()) {
      if (
        name !== "content-encoding" &&
        name !== "content-length" &&
        name !== "transfer-encoding"
      ) {
        response.setHeader(name, value);
      }
    }
    if (
      method === "GET" &&
      requestUrl.startsWith("/Items?") &&
      upstream.headers.get("content-type")?.startsWith("application/json") === true
    ) {
      collectProviderReferences(JSON.parse(body.toString("utf8")), providerReferences);
    }
    response.end(body);
  } catch {
    response.statusCode = HTTP_BAD_GATEWAY;
    response.end();
  }
};

const acquireJellyfinProxy = (jellyfin: JellyfinFixture) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: (error) => error,
      try: async (): Promise<JellyfinProxy> => {
        const providerReferences = new Set<string>();
        const requests: ObservedProviderRequest[] = [];
        const server = createServer((request, response) => {
          requests.push({
            method: request.method ?? "GET",
            url: request.url ?? "/",
          });
          void forwardJellyfinRequest({ jellyfin, providerReferences, request, response });
        });
        server.listen(EPHEMERAL_PORT, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Jellyfin proxy did not bind");
        }
        return {
          baseUrl: `http://127.0.0.1:${address.port}/`,
          providerReferences,
          requests,
          server,
        };
      },
    }),
    ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
  );

const readJson = async <Value>(response: Response): Promise<Value> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only OAuth payload shapes are consumed only through fields asserted by this scenario.
  (await response.json()) as Value;

const postOAuthForm = (url: string, fields: Readonly<Record<string, string>>) =>
  fetch(url, {
    body: new URLSearchParams(fields),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });

const readCatalogImport = (databaseUrl: string, providerInstanceId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async (): Promise<CatalogImportSnapshot> => {
      const result = await pool.query<{
        readonly canonical_item_count: number;
        readonly library_entry_count: number;
        readonly status: string | null;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM canonical_item) AS canonical_item_count,
           (SELECT count(*)::integer FROM library_entry) AS library_entry_count,
           (SELECT status FROM provider_catalog_scan_state
             WHERE provider_instance_id = $1) AS status`,
        [providerInstanceId],
      );
      const row = result.rows.at(FIRST_INDEX);
      if (row === undefined) {
        throw new Error("catalog import snapshot is missing");
      }
      return {
        canonicalItemCount: row.canonical_item_count,
        libraryEntryCount: row.library_entry_count,
        status: row.status,
      };
    }),
  );

const waitForCatalogImport = (databaseUrl: string, providerInstanceId: string) =>
  Effect.gen(function* waitForCompleteCatalogImport() {
    const deadline = (yield* Clock.currentTimeMillis) + CATALOG_IMPORT_WAIT_MILLISECONDS;
    while (true) {
      const snapshot = yield* readCatalogImport(databaseUrl, providerInstanceId);
      if (snapshot.status === "succeeded") {
        return snapshot;
      }
      if (snapshot.status === "failed") {
        return yield* Effect.die(new Error("catalog import failed"));
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error("catalog import did not complete"));
      }
      yield* Effect.sleep(CATALOG_IMPORT_POLL_MILLISECONDS);
    }
  });

const configureProvider = (flow: AuthenticationFlow, nama: NamaRunner, jellyfin: JellyfinFixture) =>
  Effect.gen(function* configureProductionProvider() {
    const profile = yield* nama([
      "profile",
      "set",
      "local",
      "--server",
      flow.runningProcess.origin,
      "--output",
      "json",
    ]);
    expect(profile).toMatchObject({ exitCode: 0, stderr: "" });
    const configuration = JSON.stringify({
      api_key: jellyfin.primaryApiKey,
      base_url: jellyfin.baseUrl,
      user_id: jellyfin.primaryUserId,
    });
    const created = yield* nama(
      [
        "provider",
        "instance",
        "create",
        PROVIDER_TYPE_ID,
        "--display-name",
        "Universal Browse",
        "--configuration",
        "-",
        "--operation-id",
        PROVIDER_OPERATION_ID,
        "--profile",
        "local",
        "--output",
        "json",
      ],
      configuration,
    );
    expect(created).toMatchObject({ exitCode: 0, stderr: "" });
    const providerInstance = providerInstanceFromNama(created);
    expect(providerInstance).toMatchObject({ enabled: true, status: "healthy" });
    return requiredString(providerInstance, "id");
  });

const authorizeAppleClient = (flow: AuthenticationFlow, nama: NamaRunner) =>
  Effect.gen(function* authorizeProductionAppleClient() {
    const protectedMetadataResponse = yield* Effect.promise(() =>
      fetch(`${flow.runningProcess.origin}/.well-known/oauth-protected-resource`, {
        redirect: "manual",
      }),
    );
    expect(protectedMetadataResponse.status).toBe(HTTP_OK);
    const { resource } = yield* Effect.promise(() =>
      readJson<ProtectedResourceMetadata>(protectedMetadataResponse),
    );
    const deviceResponse = yield* Effect.promise(() =>
      postOAuthForm(`${flow.runningProcess.origin}/device/code`, {
        client_id: APPLE_CLIENT_ID,
        resource,
        scope: AUTHORIZATION_SCOPE,
      }),
    );
    expect(deviceResponse.status).toBe(HTTP_OK);
    const device = yield* Effect.promise(() =>
      readJson<DeviceAuthorizationResponse>(deviceResponse),
    );
    const approval = yield* nama([
      "auth",
      "approve-device",
      device.user_code,
      "--server",
      flow.runningProcess.origin,
      "--output",
      "json",
    ]);
    expect(approval).toMatchObject({ exitCode: 0, stderr: "" });
    const tokenResponse = yield* Effect.promise(() =>
      postOAuthForm(`${flow.runningProcess.origin}/oauth2/token`, {
        client_id: APPLE_CLIENT_ID,
        device_code: device.device_code,
        grant_type: DEVICE_CODE_GRANT,
        resource,
      }),
    );
    expect(tokenResponse.status).toBe(HTTP_OK);
    const token = yield* Effect.promise(() => readJson<TokenResponse>(tokenResponse));
    expect(token.access_token.split(".")).toHaveLength(JWT_SEGMENT_COUNT);
    return token.access_token;
  });

const required = <Value>(value: Value | undefined, description: string): Value => {
  if (value === undefined) {
    throw new Error(`missing ${description}`);
  }
  return value;
};

const publicBoundaryJson = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === "bigint") {
      return field.toString();
    }
    return field;
  });

const exerciseBrowseFlow = ({
  accessToken,
  flow,
  jellyfin,
  providerRequestCount,
  proxy,
}: BrowseFlowInput) =>
  Effect.gen(function* exerciseProductionBrowseFlow() {
    const transport = createConnectTransport({
      baseUrl: flow.runningProcess.origin,
      httpVersion: "1.1",
    });
    const client = createClient(LibraryService, transport);
    const requestMetadata = {
      authorization: `Bearer ${accessToken}`,
      "nama-client-name": "nama-ios",
      "nama-client-platform": "ios",
      "nama-client-version": "0.0.0",
    } as const;
    const options = {
      headers: requestMetadata,
      timeoutMs: REQUEST_TIMEOUT_MILLISECONDS,
    } as const;
    const home = yield* Effect.promise(() =>
      client.getHome({ sectionSize: HOME_SECTION_SIZE }, options),
    );
    expect(home.sections.map(({ kind }) => kind)).toEqual([
      HomeSectionKind.MOVIES,
      HomeSectionKind.SHOWS,
    ]);
    const homeItems = home.sections.flatMap(({ items }) => items);
    const movieSummary = required(
      homeItems.find(({ kind }) => kind === MediaKind.MOVIE),
      "Home Movie",
    );
    const showSummary = required(
      homeItems.find(({ kind }) => kind === MediaKind.SHOW),
      "Home Show",
    );

    const sortedLibraryPages = [];
    for (const sort of [
      LibrarySort.TITLE_ASC,
      LibrarySort.RELEASE_DATE_DESC,
      LibrarySort.DATE_ADDED_DESC,
    ]) {
      for (const kind of [MediaKind.MOVIE, MediaKind.SHOW]) {
        const page = yield* Effect.promise(() =>
          client.listLibrary(
            {
              filter: { kinds: [kind], watchFilter: WatchFilter.ANY },
              pageSize: SINGLE_ITEM_PAGE_SIZE,
              sort,
            },
            options,
          ),
        );
        expect(page.items.length).toBeGreaterThan(EMPTY_LENGTH);
        expect(page.items.every((item) => item.kind === kind)).toBe(true);
        sortedLibraryPages.push(page);
      }
    }

    const firstPage = yield* Effect.promise(() =>
      client.listLibrary(
        {
          filter: { watchFilter: WatchFilter.ANY },
          pageSize: SINGLE_ITEM_PAGE_SIZE,
          sort: LibrarySort.DATE_ADDED_DESC,
        },
        options,
      ),
    );
    expect(firstPage.nextPageToken).not.toBe("");
    const secondPage = yield* Effect.promise(() =>
      client.listLibrary(
        {
          filter: { watchFilter: WatchFilter.ANY },
          pageSize: SINGLE_ITEM_PAGE_SIZE,
          pageToken: firstPage.nextPageToken,
          sort: LibrarySort.DATE_ADDED_DESC,
        },
        options,
      ),
    );
    expect(secondPage.items).toHaveLength(SINGLE_ITEM_PAGE_SIZE);
    expect(secondPage.items[FIRST_INDEX]?.id).not.toBe(firstPage.items[FIRST_INDEX]?.id);

    const search = yield* Effect.promise(() =>
      client.search(
        {
          kinds: [MediaKind.MOVIE, MediaKind.SHOW, MediaKind.SEASON, MediaKind.EPISODE],
          pageSize: SEARCH_PAGE_SIZE,
          query: "Nama",
        },
        options,
      ),
    );
    expect(search.items.some(({ kind }) => kind === MediaKind.MOVIE)).toBe(true);
    expect(search.items.some(({ kind }) => kind === MediaKind.SHOW)).toBe(true);
    expect(search.items.some(({ kind }) => kind === MediaKind.EPISODE)).toBe(true);

    const showChildren = yield* Effect.promise(() =>
      client.listChildren(
        { pageSize: SINGLE_ITEM_PAGE_SIZE, parentMediaId: showSummary.id },
        options,
      ),
    );
    const seasonSummary = required(showChildren.items.at(FIRST_INDEX), "Show Season");
    expect(seasonSummary.kind).toBe(MediaKind.SEASON);
    const seasonChildren = yield* Effect.promise(() =>
      client.listChildren(
        { pageSize: SINGLE_ITEM_PAGE_SIZE, parentMediaId: seasonSummary.id },
        options,
      ),
    );
    const episodeSummary = required(seasonChildren.items.at(FIRST_INDEX), "Season Episode");
    expect(episodeSummary.kind).toBe(MediaKind.EPISODE);

    const movie = required(
      (yield* Effect.promise(() => client.getMedia({ mediaId: movieSummary.id }, options))).media,
      "Movie Details",
    );
    const show = required(
      (yield* Effect.promise(() => client.getMedia({ mediaId: showSummary.id }, options))).media,
      "Show Details",
    );
    const season = required(
      (yield* Effect.promise(() => client.getMedia({ mediaId: seasonSummary.id }, options))).media,
      "Season Details",
    );
    const episode = required(
      (yield* Effect.promise(() => client.getMedia({ mediaId: episodeSummary.id }, options))).media,
      "Episode Details",
    );
    expect([
      movie.kindDetails.case,
      show.kindDetails.case,
      season.kindDetails.case,
      episode.kindDetails.case,
    ]).toEqual(["movie", "show", "season", "episode"]);
    expect(season.parents.map(({ id }) => id)).toContain(showSummary.id);
    expect(episode.parents.map(({ id }) => id)).toEqual([showSummary.id, seasonSummary.id]);

    const movieSourceSummary = required(movie.sourceSummaries.at(FIRST_INDEX), "Movie Source");
    const episodeSourceSummary = required(
      episode.sourceSummaries.at(FIRST_INDEX),
      "Episode Source",
    );
    const movieSource = required(
      (yield* Effect.promise(() =>
        client.getMediaSource(
          { mediaId: movieSummary.id, sourceId: movieSourceSummary.id },
          options,
        ),
      )).source,
      "Movie Source details",
    );
    const episodeSource = required(
      (yield* Effect.promise(() =>
        client.getMediaSource(
          { mediaId: episodeSummary.id, sourceId: episodeSourceSummary.id },
          options,
        ),
      )).source,
      "Episode Source details",
    );
    expect(movieSource.mediaId).toBe(movieSummary.id);
    expect(episodeSource.mediaId).toBe(episodeSummary.id);
    const invalidPageTokenFailure = yield* Effect.tryPromise({
      catch: (error) => error,
      try: () =>
        client.listLibrary(
          {
            filter: { watchFilter: WatchFilter.ANY },
            pageSize: SINGLE_ITEM_PAGE_SIZE,
            pageToken: "invalid-page-token",
            sort: LibrarySort.DATE_ADDED_DESC,
          },
          options,
        ),
    }).pipe(Effect.flip);
    if (!(invalidPageTokenFailure instanceof ConnectError)) {
      throw new TypeError("expected an invalid page-token failure");
    }
    expect(invalidPageTokenFailure.code).toBe(Code.InvalidArgument);
    expect(proxy.requests).toHaveLength(providerRequestCount);

    const poster = required(
      movie.artwork.find(({ role }) => role === ArtworkRole.POSTER),
      "Movie poster",
    );
    const locator = required(
      (yield* Effect.promise(() =>
        client.resolveArtwork(
          {
            artworkId: poster.id,
            maxHeight: ARTWORK_MAX_HEIGHT,
            maxWidth: ARTWORK_MAX_WIDTH,
          },
          options,
        ),
      )).locator,
      "Artwork locator",
    );
    const artworkResponse = yield* Effect.promise(() =>
      fetch(locator.url, {
        headers: Object.fromEntries(locator.headers.map(({ name, value }) => [name, value])),
        redirect: "manual",
      }),
    );
    expect(artworkResponse.status).toBe(HTTP_OK);
    expect(artworkResponse.headers.get("content-type")).toMatch(/^image\//u);
    expect((yield* Effect.promise(() => artworkResponse.arrayBuffer())).byteLength).toBeGreaterThan(
      EMPTY_LENGTH,
    );
    const artworkRequests = proxy.requests.slice(providerRequestCount);
    expect(artworkRequests.map(({ method }) => method)).toEqual(["HEAD", "GET"]);
    expect(artworkRequests.every(({ url }) => url.includes("/Images/"))).toBe(true);

    const ordinaryPublicValues = publicBoundaryJson({
      episode,
      episodeSource,
      firstPage,
      home,
      invalidPageTokenFailure: {
        code: invalidPageTokenFailure.code,
        details: invalidPageTokenFailure.details,
        metadata: [...invalidPageTokenFailure.metadata.entries()],
        rawMessage: invalidPageTokenFailure.rawMessage,
      },
      movie,
      movieSource,
      requestMetadata: {
        "nama-client-name": requestMetadata["nama-client-name"],
        "nama-client-platform": requestMetadata["nama-client-platform"],
        "nama-client-version": requestMetadata["nama-client-version"],
      },
      search,
      season,
      seasonChildren,
      secondPage,
      show,
      showChildren,
      sortedLibraryPages,
    });
    const processOutput = `${flow.runningProcess.stdout()}\n${flow.runningProcess.stderr()}`;
    const privateSentinels = [
      jellyfin.baseUrl,
      jellyfin.primaryApiKey,
      jellyfin.primaryUserId,
      jellyfin.serverId,
      ...proxy.providerReferences,
    ];
    for (const sentinel of privateSentinels) {
      expect(ordinaryPublicValues).not.toContain(sentinel);
      expect(processOutput).not.toContain(sentinel);
    }
    const artworkBoundary = publicBoundaryJson(locator);
    for (const sentinel of [
      jellyfin.primaryApiKey,
      jellyfin.primaryUserId,
      jellyfin.serverId,
      ...proxy.providerReferences,
    ]) {
      expect(artworkBoundary).not.toContain(sentinel);
    }
  });

it.live.skipIf(process.env["NAMA_TEST_JELLYFIN_URL"] === undefined)(
  "browses the imported canonical catalog through an OAuth-authorized Apple client",
  () =>
    provisionJellyfin.pipe(
      Effect.flatMap((jellyfin) =>
        Effect.scoped(
          Effect.gen(function* proxiedUniversalBrowseFlow() {
            const proxy = yield* acquireJellyfinProxy(jellyfin);
            const proxiedJellyfin = { ...jellyfin, baseUrl: proxy.baseUrl };
            return yield* withIsolatedDatabase((databaseUrl) =>
              withNamaBinary(({ binary, home }) =>
                Effect.acquireUseRelease(
                  startAuthenticationFlow({
                    databaseUrl,
                    displayName: "Universal Browse Administrator",
                    email: ADMINISTRATOR_EMAIL,
                    invalidSetupFieldViolations: [],
                    password: ADMINISTRATOR_PASSWORD,
                    signedBearerPattern: /^[A-Za-z0-9]{32}\.[A-Za-z0-9+/]{43}=$/u,
                    startupSensitiveValues: [ADMINISTRATOR_PASSWORD],
                    unknownEmail: "unknown@universal-browse.test",
                    wrongBootstrapToken: "wrong-bootstrap-token",
                    wrongPassword: "wrong-password-for-universal-browse",
                  }),
                  (flow) =>
                    Effect.gen(function* universalBrowseFlowTest() {
                      const configured = yield* completeAdministratorSetup(flow);
                      const session = yield* signInAdministrator(
                        flow,
                        configured.expectedAdministrator,
                        "Universal browse SignIn",
                      );
                      const nama = createNamaRunner(binary, cliEnvironment(home, session.token));
                      const providerInstanceId = yield* configureProvider(
                        flow,
                        nama,
                        proxiedJellyfin,
                      );
                      const catalog = yield* waitForCatalogImport(databaseUrl, providerInstanceId);
                      expect(catalog.status).toBe("succeeded");
                      expect(catalog.canonicalItemCount).toBeGreaterThanOrEqual(
                        EXPECTED_CANONICAL_KIND_COUNT,
                      );
                      expect(catalog.libraryEntryCount).toBeGreaterThanOrEqual(
                        EXPECTED_CANONICAL_KIND_COUNT,
                      );
                      const accessToken = yield* authorizeAppleClient(flow, nama);
                      yield* exerciseBrowseFlow({
                        accessToken,
                        flow,
                        jellyfin: proxiedJellyfin,
                        providerRequestCount: proxy.requests.length,
                        proxy,
                      });
                    }),
                  (flow) => stopCleanly(flow.runningProcess),
                ),
              ),
            );
          }),
        ),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
