import type { RequestListener } from "node:http";

import { Effect } from "effect";

import { APPLE_PUBLIC_CLIENT_ID, CONSUMER_SCOPES } from "../config/oauth.ts";
import { authenticationStoreUnavailable, invalidBearer } from "./better-auth-adapter-private.ts";
import type { InvalidBearer, StoreFailure } from "./better-auth-adapter-private.ts";
import {
  invokeRuntimeFunction,
  isObjectValue,
  readProperty,
} from "./better-auth-adapter-runtime.ts";
import type { RuntimeFunction } from "./better-auth-adapter-runtime.ts";

const JWT_SEGMENT_COUNT = 3;
const PATH_START_INDEX = 0;
const TRAILING_SLASH_END_INDEX = -1;
const EMPTY_STRING_LENGTH = 0;
const isRuntimeFunction = (value: unknown): value is RuntimeFunction => typeof value === "function";

const jwksUnavailable = new Error("Better Auth JWKS unavailable");
const permissionDenied: PermissionDenied = Object.freeze({ _tag: "PermissionDenied" });
type AuthenticatedPrincipal = Readonly<{ readonly id: string }>;
type PermissionDenied = Readonly<{ readonly _tag: "PermissionDenied" }>;
type OAuthAccessFailure = StoreFailure | InvalidBearer | PermissionDenied;
type ResolveOAuthAccess = (
  authorization: string,
  requiredScope: string,
) => Effect.Effect<AuthenticatedPrincipal, OAuthAccessFailure>;

const issuerForResource = (resource: string): string => {
  if (resource.endsWith("/")) {
    return resource.slice(PATH_START_INDEX, TRAILING_SLASH_END_INDEX);
  }
  return resource;
};

const requestPath = (target: string): string => {
  const queryIndex = target.indexOf("?");
  if (queryIndex >= PATH_START_INDEX) {
    return target.slice(PATH_START_INDEX, queryIndex);
  }
  return target;
};

const makeOAuthRequestListener = (
  betterAuthRequestListener: RequestListener,
  resource: string,
): RequestListener => {
  const protectedResourceMetadata = JSON.stringify({
    authorization_servers: [issuerForResource(resource)],
    resource,
    scopes_supported: [...CONSUMER_SCOPES],
  });
  return (request, response) => {
    const path = requestPath(request.url ?? "");
    if (request.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      response.statusCode = 200;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json");
      response.end(protectedResourceMetadata);
      return;
    }
    betterAuthRequestListener(request, response);
  };
};

const readOAuthBearerToken = (authorization: string): string | undefined => {
  const match = /^Bearer (?<token>[^\s]+)$/iu.exec(authorization);
  const token = match?.groups?.["token"];
  if (token === undefined || token.split(".").length !== JWT_SEGMENT_COUNT) {
    return undefined;
  }
  return token;
};

const readJwksMethod = (runtime: unknown): Readonly<{ api: object; getJwks: RuntimeFunction }> => {
  if (!isObjectValue(runtime)) {
    throw jwksUnavailable;
  }
  const api = readProperty(runtime, "api");
  if (!isObjectValue(api)) {
    throw jwksUnavailable;
  }
  const getJwks = readProperty(api, "getJwks");
  if (!isRuntimeFunction(getJwks)) {
    throw jwksUnavailable;
  }
  return { api, getJwks };
};

const makeJwksFetch =
  (runtime: unknown): (() => Promise<object>) =>
  async () => {
    try {
      const { api, getJwks } = readJwksMethod(runtime);
      const result: unknown = await Promise.resolve(Reflect.apply(getJwks, api, [{}]));
      if (!isObjectValue(result) || !Array.isArray(readProperty(result, "keys"))) {
        throw jwksUnavailable;
      }
      return result;
    } catch {
      throw jwksUnavailable;
    }
  };

const principalIdFromPayload = (payload: object): string | undefined => {
  if (readProperty(payload, "client_id") !== APPLE_PUBLIC_CLIENT_ID) {
    return undefined;
  }
  const subject = readProperty(payload, "sub");
  if (typeof subject !== "string" || subject.length === EMPTY_STRING_LENGTH) {
    return undefined;
  }
  return subject;
};

const payloadHasScope = (payload: object, requiredScope: string): boolean => {
  const scope = readProperty(payload, "scope");
  return typeof scope === "string" && scope.split(/\s+/u).includes(requiredScope);
};

const principalFromPayload = (
  payload: unknown,
  requiredScope: string,
): Effect.Effect<AuthenticatedPrincipal, OAuthAccessFailure> => {
  if (!isObjectValue(payload)) {
    return Effect.fail(invalidBearer);
  }
  const subject = principalIdFromPayload(payload);
  if (subject === undefined) {
    return Effect.fail(invalidBearer);
  }
  if (!payloadHasScope(payload, requiredScope)) {
    return Effect.fail(permissionDenied);
  }
  return Effect.succeed(Object.freeze({ id: subject }));
};

const makeResolveOAuthAccess = (
  runtime: unknown,
  resource: string,
  verifyJwsAccessToken: RuntimeFunction,
): ResolveOAuthAccess => {
  const issuer = issuerForResource(resource);
  const jwksCacheKey = Object.freeze({});
  const jwksFetch = makeJwksFetch(runtime);
  return (authorization, requiredScope) =>
    Effect.suspend(() => {
      const token = readOAuthBearerToken(authorization);
      if (token === undefined) {
        return Effect.fail(invalidBearer);
      }
      return Effect.tryPromise({
        catch: (rejection) => {
          if (rejection === jwksUnavailable) {
            return authenticationStoreUnavailable;
          }
          return invalidBearer;
        },
        try: () =>
          Promise.resolve(
            invokeRuntimeFunction(verifyJwsAccessToken, [
              token,
              {
                jwksCacheKey,
                jwksFetch,
                verifyOptions: { audience: resource, issuer },
              },
            ]),
          ),
      }).pipe(Effect.flatMap((payload) => principalFromPayload(payload, requiredScope)));
    });
};

export { makeOAuthRequestListener, makeResolveOAuthAccess };
export type { AuthenticatedPrincipal, OAuthAccessFailure, PermissionDenied, ResolveOAuthAccess };
