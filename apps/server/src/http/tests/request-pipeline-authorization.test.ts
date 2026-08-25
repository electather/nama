// oxlint-disable import/max-dependencies, eslint/max-statements -- The authorization inventory scenario keeps administrator, principal, scoped consumer, and plugin authority ordering visible together.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { AuthService } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { LibraryService } from "../../../../../gen/ts/src/nama/api/v1/library_pb.js";
import { PlaybackService } from "../../../../../gen/ts/src/nama/api/v1/playback_pb.js";
import { UserStateService } from "../../../../../gen/ts/src/nama/api/v1/user_state_pb.js";
import { PluginService } from "../../../../../gen/ts/src/nama/plugin/v1/plugin_pb.js";
import {
  createRequestPipeline,
  getRequestAdministrator,
  getRequestPrincipal,
} from "../request-pipeline.ts";
import type { RequestPipelineDependencies } from "../request-pipeline.ts";
import { expectApplicationError } from "./request-pipeline-assertions.ts";
import {
  ADMINISTRATOR,
  bearerHeader,
  invoke,
  makeTestAuthenticationService,
  makeDependencies,
  responseFor,
  succeedEffect,
  traceEffect,
  traceFailureEffect,
  withRequestId,
} from "./request-pipeline-fixtures.ts";

const MISSING_INVENTORY_METHOD_NAME = "NotInInventory";
const MISSING_INVENTORY_LOCAL_NAME = "notInInventory";
const MALFORMED_AUTHORIZATION = "Basic";
const INVALID_BEARER = Object.freeze({ _tag: "InvalidBearer" as const });
const UNIMPLEMENTED_HANDLER_MESSAGE = "Handler is not implemented.";
const AUTHENTICATION_STORE_UNAVAILABLE = Object.freeze({
  _tag: "AuthenticationStoreUnavailable" as const,
});

const INVOKE_NEXT_PARAMETER = 2;

type HeaderFactory = () => Headers;
type RequestHandler = Exclude<Parameters<typeof invoke>[typeof INVOKE_NEXT_PARAMETER], undefined>;

const HEADER_FACTORIES = [
  () => new Headers(),
  () => new Headers({ authorization: MALFORMED_AUTHORIZATION }),
  bearerHeader,
] as const satisfies readonly HeaderFactory[];

const CURRENT_ADMINISTRATOR_MESSAGE = create(AuthService.method.getCurrentUser.input);
const CURRENT_ADMINISTRATOR_REQUEST = withRequestId(
  AuthService.method.getCurrentUser,
  CURRENT_ADMINISTRATOR_MESSAGE,
  { header: bearerHeader() },
);
const PUBLIC_SIGN_IN_MESSAGE = create(AuthService.method.signIn.input);
const PUBLIC_SIGN_IN_REQUEST = withRequestId(AuthService.method.signIn, PUBLIC_SIGN_IN_MESSAGE);

const createPipeline = (overrides: Partial<RequestPipelineDependencies>) => {
  const dependencies = makeDependencies(overrides);
  return createRequestPipeline(dependencies);
};

const createCurrentAdministratorRequest = (header: Headers) => {
  const message = create(AuthService.method.getCurrentUser.input);
  return withRequestId(AuthService.method.getCurrentUser, message, { header });
};

const recordDispatch =
  (trace: string[]): RequestHandler =>
  (received) => {
    trace.push("next");
    const response = responseFor(received);
    return Promise.resolve(response);
  };

const recordAdministrator =
  (trace: string[], seenAdministratorIds: string[]): RequestHandler =>
  (received) => {
    trace.push("next");
    const administrator = getRequestAdministrator(received.contextValues);
    if (administrator !== undefined) {
      seenAdministratorIds.push(administrator.id);
    }
    const response = responseFor(received);
    return Promise.resolve(response);
  };
const recordPrincipal =
  (trace: string[], seenPrincipalIds: string[]): RequestHandler =>
  (received) => {
    trace.push("next");
    const principal = getRequestPrincipal(received.contextValues);
    if (principal !== undefined) {
      seenPrincipalIds.push(principal.id);
    }
    return Promise.resolve(responseFor(received));
  };

const expectInvalidAdministratorCredential = async (makeHeader: HeaderFactory): Promise<void> => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolveAdministrator: () => traceFailureEffect(trace, "resolve", INVALID_BEARER),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return { kind: "valid" as const };
    },
  };
  const interceptor = createPipeline({ authentication, requestValidator });
  const request = createCurrentAdministratorRequest(makeHeader());
  const promise = invoke(interceptor, request, recordDispatch(trace));

  await expectApplicationError({
    code: Code.Unauthenticated,
    promise,
    reason: "CREDENTIAL_INVALID",
  });
  expect(trace).not.toContain("validate");
  expect(trace).not.toContain("next");
};

test("denies a decoded unary method absent from the authority inventory before validation or dispatch", async () => {
  const trace: string[] = [];
  const missingInventoryMethod = Object.freeze({
    ...AuthService.method.signIn,
    localName: MISSING_INVENTORY_LOCAL_NAME,
    name: MISSING_INVENTORY_METHOD_NAME,
  });
  const interceptor = createPipeline({
    requestValidator: {
      validate: () => {
        trace.push("validate");
        return { kind: "valid" as const };
      },
    },
  });

  const promise = invoke(
    interceptor,
    withRequestId(missingInventoryMethod, create(missingInventoryMethod.input)),
    recordDispatch(trace),
  );

  await expectApplicationError({
    code: Code.PermissionDenied,
    promise,
    reason: "PERMISSION_DENIED",
  });

  expect(trace).toStrictEqual([]);
});

test("accepts a session for administrator and consumer methods", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolveAdministrator: () => traceEffect(trace, "resolve-administrator", ADMINISTRATOR),
    resolveConsumerPrincipal: (_authorization, scope) =>
      traceEffect(trace, `resolve-consumer:${scope}`, ADMINISTRATOR),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return { kind: "valid" as const };
    },
  };
  const seenPrincipalIds: string[] = [];
  const interceptor = createPipeline({ authentication, requestValidator });
  const administratorNext = recordAdministrator(trace, seenPrincipalIds);
  const principalNext = recordPrincipal(trace, seenPrincipalIds);

  await invoke(
    interceptor,
    withRequestId(
      AuthService.method.getCurrentUser,
      create(AuthService.method.getCurrentUser.input),
      {
        header: bearerHeader(),
      },
    ),
    administratorNext,
  );
  await invoke(
    interceptor,
    withRequestId(LibraryService.method.getHome, create(LibraryService.method.getHome.input), {
      header: bearerHeader(),
    }),
    principalNext,
  );

  expect(trace).toStrictEqual([
    "resolve-administrator",
    "validate",
    "next",
    "resolve-consumer:nama:library",
    "validate",
    "next",
  ]);
  expect(seenPrincipalIds).toStrictEqual([ADMINISTRATOR.id, ADMINISTRATOR.id]);
});
test("passes each consumer method group's exact OAuth scope requirement", async () => {
  const seenScopes: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolveConsumerPrincipal: (_authorization, scope) =>
      Effect.sync(() => {
        seenScopes.push(scope);
        return ADMINISTRATOR;
      }),
  });
  const interceptor = createPipeline({ authentication });

  await invoke(
    interceptor,
    withRequestId(
      PlaybackService.method.planPlayback,
      create(PlaybackService.method.planPlayback.input),
      { header: bearerHeader() },
    ),
    () => Promise.resolve(responseFor(CURRENT_ADMINISTRATOR_REQUEST)),
  );
  await invoke(
    interceptor,
    withRequestId(
      UserStateService.method.getUserState,
      create(UserStateService.method.getUserState.input),
      { header: bearerHeader() },
    ),
    () => Promise.resolve(responseFor(CURRENT_ADMINISTRATOR_REQUEST)),
  );

  expect(seenScopes).toStrictEqual(["nama:playback", "nama:user-state"]);
});
test("admits device approval through authenticated-principal authority without an Administrator check", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolvePrincipal: () => traceEffect(trace, "resolve-principal", ADMINISTRATOR),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return { kind: "valid" as const };
    },
  };
  const interceptor = createPipeline({ authentication, requestValidator });

  await invoke(
    interceptor,
    withRequestId(
      AuthService.method.approveDeviceAuthorization,
      create(AuthService.method.approveDeviceAuthorization.input, { userCode: "ABCD-EFGH" }),
      { header: bearerHeader() },
    ),
    recordDispatch(trace),
  );

  expect(trace).toStrictEqual(["resolve-principal", "validate", "next"]);
});

test("fails closed for plugin-only authority without dispatch", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolveAdministrator: () => traceEffect(trace, "resolve", ADMINISTRATOR),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return { kind: "valid" as const };
    },
  };
  const interceptor = createPipeline({ authentication, requestValidator });

  const promise = invoke(
    interceptor,
    withRequestId(PluginService.method.getInfo, create(PluginService.method.getInfo.input), {
      header: bearerHeader(),
    }),
    recordDispatch(trace),
  );

  await expectApplicationError({
    code: Code.PermissionDenied,
    promise,
    reason: "PERMISSION_DENIED",
  });
  expect(trace).toStrictEqual([]);
});

test("maps absent, malformed, and invalid administrator credentials to CREDENTIAL_INVALID", async () => {
  await Promise.all(
    HEADER_FACTORIES.map((makeHeader) => expectInvalidAdministratorCredential(makeHeader)),
  );
});

test("maps authoritative session-store failure to AUTHENTICATION_UNAVAILABLE", async () => {
  const authentication = makeTestAuthenticationService({
    resolveAdministrator: () => traceFailureEffect([], "resolve", AUTHENTICATION_STORE_UNAVAILABLE),
  });
  const promise = invoke(
    createPipeline({ authentication }),
    createCurrentAdministratorRequest(bearerHeader()),
  );

  await expectApplicationError({
    code: Code.Unavailable,
    promise,
    reason: "AUTHENTICATION_UNAVAILABLE",
  });
});

test("authenticates a protected request before validation and Connect's unimplemented handler", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    resolveConsumerPrincipal: () => traceFailureEffect(trace, "resolve", INVALID_BEARER),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return { kind: "valid" as const };
    },
  };

  const promise = invoke(
    createPipeline({ authentication, requestValidator }),
    withRequestId(LibraryService.method.getHome, create(LibraryService.method.getHome.input), {
      header: bearerHeader(),
    }),
    () => Promise.reject(new ConnectError(UNIMPLEMENTED_HANDLER_MESSAGE, Code.Unimplemented)),
  );

  await expectApplicationError({
    code: Code.Unauthenticated,
    promise,
    reason: "CREDENTIAL_INVALID",
  });

  expect(trace).toStrictEqual(["resolve"]);
});

test("keeps administrator context request-local and absent from a concurrent public call", async () => {
  const interceptor = createPipeline({
    authentication: makeTestAuthenticationService({
      resolveAdministrator: () => succeedEffect(ADMINISTRATOR),
    }),
  });
  const firstGate = Promise.withResolvers<void>();
  const seenAdministratorIds: (string | undefined)[] = [];
  const firstInvocation = invoke(interceptor, CURRENT_ADMINISTRATOR_REQUEST, async (received) => {
    seenAdministratorIds.push(getRequestAdministrator(received.contextValues)?.id);
    await firstGate.promise;
    seenAdministratorIds.push(getRequestAdministrator(received.contextValues)?.id);
    return responseFor(received);
  });
  const secondInvocation = invoke(interceptor, PUBLIC_SIGN_IN_REQUEST, (received) => {
    seenAdministratorIds.push(getRequestAdministrator(received.contextValues)?.id);
    return Promise.resolve(responseFor(received));
  });

  await secondInvocation;
  firstGate.resolve();
  await firstInvocation;
  expect(seenAdministratorIds).toStrictEqual([ADMINISTRATOR.id, undefined, ADMINISTRATOR.id]);
});
