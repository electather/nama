import { Effect } from "effect";

import {
  expectJellyfinResponseStatus as expectResponseStatus,
  jellyfinJsonObject as jsonObject,
  jellyfinJsonObjectArrayResponse as jsonArrayResponse,
  jellyfinJsonObjectResponse as jsonResponse,
} from "./jellyfin-http.test-support.ts";
import { ensureRepresentativeMedia } from "./jellyfin-real-provider.test-support.ts";

const EMPTY_LENGTH = 0;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

interface JellyfinFixture {
  readonly administratorAccessToken: string;
  readonly baseUrl: string;
  readonly disabledUserId: string;
  readonly otherUserId: string;
  readonly primaryApiKey: string;
  readonly primaryUserId: string;
  readonly replacementApiKey: string;
  readonly serverId: string;
}

interface JellyfinPostInput {
  readonly authorization?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly method?: "DELETE" | "POST";
  readonly path: string;
}

interface JellyfinIdentity {
  readonly administratorAccessToken: string;
  readonly primaryUserId: string;
  readonly serverId: string;
}

const requiredString = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === EMPTY_LENGTH) {
    throw new TypeError(`expected ${key} string`);
  }
  return value;
};

const requiredObject = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): Record<string, unknown> => jsonObject(record[key], `expected ${description}`);

const jellyfinPost = (baseUrl: string, input: JellyfinPostInput): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.authorization !== undefined) {
    headers["authorization"] = input.authorization;
  }
  const request: RequestInit = { headers, method: input.method ?? "POST" };
  if (input.body !== undefined) {
    request.body = JSON.stringify(input.body);
  }
  return fetch(new URL(input.path, baseUrl), request);
};

const jellyfinAuthorization = (deviceId: string, token?: string): string => {
  let tokenParameter = "";
  if (token !== undefined) {
    tokenParameter = `, Token="${token}"`;
  }
  return `MediaBrowser Client="Nama", Device="Integration Test", DeviceId="${deviceId}", Version="0.0.0"${tokenParameter}`;
};

const authenticateJellyfin = async (
  baseUrl: string,
  deviceId: string,
): Promise<Record<string, unknown>> =>
  jsonResponse(
    await jellyfinPost(baseUrl, {
      authorization: jellyfinAuthorization(deviceId),
      body: { Pw: "nama-jellyfin-password", Username: "nama-administrator" },
      path: "Users/AuthenticateByName",
    }),
    HTTP_OK,
  );

const createJellyfinUser = async (
  baseUrl: string,
  name: string,
  authorization: string,
): Promise<Record<string, unknown>> =>
  jsonResponse(
    await jellyfinPost(baseUrl, {
      authorization,
      body: { Name: name },
      path: "Users/New",
    }),
    HTTP_OK,
  );

const jellyfinStartupCompleted = async (baseUrl: string): Promise<boolean> => {
  const publicInfo = await jsonResponse(
    await fetch(new URL("System/Info/Public", baseUrl)),
    HTTP_OK,
  );
  const startupWizardCompleted = publicInfo["StartupWizardCompleted"];
  if (typeof startupWizardCompleted !== "boolean") {
    throw new TypeError("expected the Jellyfin startup-wizard state");
  }
  return startupWizardCompleted;
};

const completeJellyfinStartup = async (baseUrl: string): Promise<void> => {
  if (await jellyfinStartupCompleted(baseUrl)) {
    return;
  }

  await jsonResponse(await fetch(new URL("Startup/FirstUser", baseUrl)), HTTP_OK);
  expectResponseStatus(
    await jellyfinPost(baseUrl, {
      body: { Name: "nama-administrator", Password: "nama-jellyfin-password" },
      path: "Startup/User",
    }),
    HTTP_NO_CONTENT,
  );
  expectResponseStatus(
    await jellyfinPost(baseUrl, {
      body: {
        MetadataCountryCode: "US",
        PreferredMetadataLanguage: "en",
        ServerName: "Nama Integration Jellyfin",
        UICulture: "en-US",
      },
      path: "Startup/Configuration",
    }),
    HTTP_NO_CONTENT,
  );
  expectResponseStatus(
    await jellyfinPost(baseUrl, {
      body: { EnableAutomaticPortMapping: false, EnableRemoteAccess: false },
      path: "Startup/RemoteAccess",
    }),
    HTTP_NO_CONTENT,
  );
  expectResponseStatus(await jellyfinPost(baseUrl, { path: "Startup/Complete" }), HTTP_NO_CONTENT);
};

const jellyfinIdentity = (authenticated: Readonly<Record<string, unknown>>): JellyfinIdentity => {
  const user = requiredObject(authenticated, "User", "the authenticated Jellyfin user");
  return {
    administratorAccessToken: requiredString(authenticated, "AccessToken"),
    primaryUserId: requiredString(user, "Id"),
    serverId: requiredString(authenticated, "ServerId"),
  };
};
const apiKeyForApp = async (
  baseUrl: string,
  authorization: string,
  appName: string,
): Promise<string> => {
  const readKeys = async (): Promise<readonly Record<string, unknown>[]> => {
    const body = await jsonResponse(
      await fetch(new URL("Auth/Keys", baseUrl), { headers: { authorization } }),
      HTTP_OK,
    );
    const items = body["Items"];
    if (!Array.isArray(items)) {
      throw new TypeError("expected Jellyfin API keys");
    }
    return items.map((item) => jsonObject(item, "expected Jellyfin API key"));
  };
  const existingKeys = await readKeys();
  let apiKey = existingKeys.find((item) => item["AppName"] === appName);
  if (apiKey === undefined) {
    expectResponseStatus(
      await jellyfinPost(baseUrl, {
        authorization,
        path: `Auth/Keys?app=${encodeURIComponent(appName)}`,
      }),
      HTTP_NO_CONTENT,
    );
    const createdKeys = await readKeys();
    apiKey = createdKeys.find((item) => item["AppName"] === appName);
  }
  if (apiKey === undefined) {
    throw new TypeError("expected created Jellyfin API key");
  }
  return requiredString(apiKey, "AccessToken");
};

const provisionSecondaryUsers = async (
  baseUrl: string,
  authorization: string,
): Promise<Readonly<{ disabledUserId: string; otherUserId: string }>> => {
  const existingUsers = await jsonArrayResponse(
    await fetch(new URL("Users", baseUrl), { headers: { authorization } }),
    HTTP_OK,
  );
  const otherUser =
    existingUsers.find((user) => user["Name"] === "nama-other-user") ??
    (await createJellyfinUser(baseUrl, "nama-other-user", authorization));
  const disabledUser =
    existingUsers.find((user) => user["Name"] === "nama-disabled-user") ??
    (await createJellyfinUser(baseUrl, "nama-disabled-user", authorization));
  const disabledUserId = requiredString(disabledUser, "Id");
  const disabledPolicyInput = requiredObject(disabledUser, "Policy", "the disabled-user policy");
  expectResponseStatus(
    await jellyfinPost(baseUrl, {
      authorization,
      body: { ...disabledPolicyInput, IsDisabled: true },
      path: `Users/${disabledUserId}/Policy`,
    }),
    HTTP_NO_CONTENT,
  );
  return { disabledUserId, otherUserId: requiredString(otherUser, "Id") };
};

const configuredJellyfinFixture = async (baseUrl: string): Promise<JellyfinFixture> => {
  const authenticated = await authenticateJellyfin(baseUrl, "nama-primary");
  const identity = jellyfinIdentity(authenticated);
  const administration = jellyfinAuthorization("nama-primary", identity.administratorAccessToken);
  const secondaryUsers = await provisionSecondaryUsers(baseUrl, administration);
  await ensureRepresentativeMedia(baseUrl, administration, identity.primaryUserId);
  const primaryApiKey = await apiKeyForApp(baseUrl, administration, "Nama Integration Primary");
  const replacementApiKey = await apiKeyForApp(
    baseUrl,
    administration,
    "Nama Integration Replacement",
  );
  return {
    baseUrl,
    ...identity,
    ...secondaryUsers,
    primaryApiKey,
    replacementApiKey,
  };
};
const setJellyfinUserDisabled = (fixture: JellyfinFixture, userId: string, disabled: boolean) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<void> => {
      const authorization = jellyfinAuthorization("nama-primary", fixture.administratorAccessToken);
      const user = await jsonResponse(
        await fetch(new URL(`Users/${userId}`, fixture.baseUrl), {
          headers: { authorization },
        }),
        HTTP_OK,
      );
      const policy = requiredObject(user, "Policy", "the primary-user policy");
      expectResponseStatus(
        await jellyfinPost(fixture.baseUrl, {
          authorization,
          body: { ...policy, IsDisabled: disabled },
          path: `Users/${userId}/Policy`,
        }),
        HTTP_NO_CONTENT,
      );
    },
  });

const revokeJellyfinCredential = (fixture: JellyfinFixture) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<void> => {
      expectResponseStatus(
        await jellyfinPost(fixture.baseUrl, {
          authorization: jellyfinAuthorization("nama-replacement", fixture.replacementApiKey),
          method: "DELETE",
          path: `Auth/Keys/${fixture.primaryApiKey}`,
        }),
        HTTP_NO_CONTENT,
      );
    },
  });

const provisionJellyfinFrom = (environmentVariable: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<JellyfinFixture> => {
      const baseUrl = process.env[environmentVariable];
      if (baseUrl === undefined) {
        throw new Error(`${environmentVariable} is required`);
      }
      await completeJellyfinStartup(baseUrl);
      return configuredJellyfinFixture(baseUrl);
    },
  });

const provisionJellyfin = provisionJellyfinFrom("NAMA_TEST_JELLYFIN_URL");
const provisionReleaseJellyfin = provisionJellyfinFrom("NAMA_TEST_JELLYFIN_RELEASE_URL");

export {
  provisionJellyfin,
  provisionReleaseJellyfin,
  requiredString,
  revokeJellyfinCredential,
  setJellyfinUserDisabled,
};
export type { JellyfinFixture };
