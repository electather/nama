import { Effect } from "effect";

import {
  expectJellyfinResponseStatus as expectResponseStatus,
  jellyfinJsonObjectArrayResponse as jsonArrayResponse,
  jellyfinJsonObjectResponse as jsonResponse,
} from "./jellyfin-http.test-support.ts";
import { ensureRepresentativeMedia } from "./jellyfin-real-provider.test-support.ts";

const EMPTY_LENGTH = 0;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

interface JellyfinFixture {
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
  readonly path: string;
}

interface JellyfinIdentity {
  readonly primaryApiKey: string;
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
): Record<string, unknown> => {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`expected ${description}`);
  }
  return Object.fromEntries(Object.entries(value));
};

const jellyfinPost = (baseUrl: string, input: JellyfinPostInput): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.authorization !== undefined) {
    headers["authorization"] = input.authorization;
  }
  const request: RequestInit = { headers, method: "POST" };
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
    primaryApiKey: requiredString(authenticated, "AccessToken"),
    primaryUserId: requiredString(user, "Id"),
    serverId: requiredString(authenticated, "ServerId"),
  };
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
  const replacement = await authenticateJellyfin(baseUrl, "nama-replacement");
  const identity = jellyfinIdentity(authenticated);
  const administration = jellyfinAuthorization("nama-primary", identity.primaryApiKey);
  const secondaryUsers = await provisionSecondaryUsers(baseUrl, administration);
  await ensureRepresentativeMedia(baseUrl, administration, identity.primaryUserId);
  return {
    baseUrl,
    ...identity,
    ...secondaryUsers,
    replacementApiKey: requiredString(replacement, "AccessToken"),
  };
};

const revokeJellyfinCredential = (fixture: JellyfinFixture) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<void> => {
      expectResponseStatus(
        await jellyfinPost(fixture.baseUrl, {
          authorization: jellyfinAuthorization("nama-primary", fixture.primaryApiKey),
          path: "Sessions/Logout",
        }),
        HTTP_NO_CONTENT,
      );
    },
  });

const provisionJellyfin = Effect.tryPromise({
  catch: (error) => error,
  try: async (): Promise<JellyfinFixture> => {
    const baseUrl = process.env["NAMA_TEST_JELLYFIN_URL"];
    if (baseUrl === undefined) {
      throw new Error("NAMA_TEST_JELLYFIN_URL is required");
    }
    await completeJellyfinStartup(baseUrl);
    return configuredJellyfinFixture(baseUrl);
  },
});

export { provisionJellyfin, requiredString, revokeJellyfinCredential };
export type { JellyfinFixture };
