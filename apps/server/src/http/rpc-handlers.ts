import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import type { AuthService, SignInRequest } from "../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import type { SetupService } from "../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import type {
  AuthenticationService,
  SessionRevocationUnconfirmed,
} from "../authentication/authentication-service.ts";
import type { SetupCoordinatorService } from "../authentication/setup-coordinator.ts";
import { getRequestAdministrator } from "./request-pipeline.ts";
import type { RequestRuntime } from "./request-runtime.ts";

type Administrator = Readonly<{
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
}>;

type SetupServiceHandlerDependencies = Readonly<{
  readonly requestRuntime: RequestRuntime;
  readonly setupCoordinator: SetupCoordinatorService;
}>;

type AuthServiceHandlerDependencies = Readonly<{
  readonly authentication: AuthenticationService;
  readonly requestRuntime: RequestRuntime;
}>;

const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
});
type SignOutFailure = SessionRevocationUnconfirmed | typeof privateAuthenticationDefect;
type EmptyResponse = Readonly<Record<never, never>>;
const administratorMessage = (administrator: Administrator) => ({
  displayName: administrator.displayName,
  email: administrator.email,
  id: administrator.id,
});

const createSetupServiceHandlers = ({
  requestRuntime,
  setupCoordinator,
}: SetupServiceHandlerDependencies): Partial<ServiceImpl<typeof SetupService>> => ({
  createAdministrator: (request, context) =>
    requestRuntime.runPromise(
      setupCoordinator
        .createAdministrator({
          bootstrapToken: request.bootstrapToken,
          displayName: request.displayName,
          email: request.email,
          password: request.password,
        })
        .pipe(
          Effect.map((administrator) => ({
            administrator: administratorMessage(administrator),
          })),
        ),
      context.signal,
    ),
  getStatus: (_request, context) =>
    requestRuntime.runPromise(
      setupCoordinator.getStatus.pipe(Effect.map((initialized) => ({ initialized }))),
      context.signal,
    ),
});

const createAuthServiceHandlers = ({
  authentication,
  requestRuntime,
}: AuthServiceHandlerDependencies): Partial<ServiceImpl<typeof AuthService>> => ({
  getCurrentUser: (_request, context) =>
    requestRuntime.runPromise(
      Effect.suspend(() => {
        const administrator = getRequestAdministrator(context.values);
        if (administrator === undefined) {
          return Effect.fail(privateAuthenticationDefect);
        }
        return Effect.succeed({ administrator: administratorMessage(administrator) });
      }),
      context.signal,
    ),
  signIn: (request: SignInRequest, context) =>
    requestRuntime.runPromise(
      authentication.signIn({ email: request.email, password: request.password }).pipe(
        Effect.map(({ administrator, bearer, sessionExpiresAt }) => ({
          administrator: administratorMessage(administrator),
          credential: {
            expiresAt: timestampFromDate(sessionExpiresAt),
            token: bearer,
          },
        })),
      ),
      context.signal,
    ),
  signOut: (_request, context) =>
    requestRuntime.runPromise(
      Effect.suspend<EmptyResponse, SignOutFailure, never>(() => {
        const authorization = context.requestHeader.get("authorization");
        if (authorization === null) {
          return Effect.fail(privateAuthenticationDefect);
        }
        return authentication.signOut(authorization).pipe(Effect.as({}));
      }),
      context.signal,
    ),
});

export { createAuthServiceHandlers, createSetupServiceHandlers };
export type { AuthServiceHandlerDependencies, SetupServiceHandlerDependencies };
