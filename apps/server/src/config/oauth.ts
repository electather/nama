const APPLE_PUBLIC_CLIENT_ID = "nama-apple";
const LIBRARY_SCOPE = "nama:library";
const PLAYBACK_SCOPE = "nama:playback";
const USER_STATE_SCOPE = "nama:user-state";
const OFFLINE_ACCESS_SCOPE = "offline_access";

const CONSUMER_SCOPES = [LIBRARY_SCOPE, PLAYBACK_SCOPE, USER_STATE_SCOPE] as const;
const APPLE_AUTHORIZATION_SCOPES = [...CONSUMER_SCOPES, OFFLINE_ACCESS_SCOPE] as const;

const makeSingletonSet = (value: string): Set<string> => new Set([value]);

const makeOAuthProviderOptions = (resource: string) => ({
  cachedResources: makeSingletonSet(resource),
  cachedTrustedClients: makeSingletonSet(APPLE_PUBLIC_CLIENT_ID),
  consentPage: "/oauth/not-available",
  grantTypes: ["authorization_code", "refresh_token"] as const,
  loginPage: "/oauth/not-available",
  scopes: [...APPLE_AUTHORIZATION_SCOPES],
});

export {
  APPLE_AUTHORIZATION_SCOPES,
  APPLE_PUBLIC_CLIENT_ID,
  CONSUMER_SCOPES,
  LIBRARY_SCOPE,
  PLAYBACK_SCOPE,
  USER_STATE_SCOPE,
  makeOAuthProviderOptions,
};
