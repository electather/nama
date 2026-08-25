import { AuthService } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { HealthService } from "../../../../../gen/ts/src/nama/api/v1/health_pb.js";
import { LibraryService } from "../../../../../gen/ts/src/nama/api/v1/library_pb.js";
import { PlaybackService } from "../../../../../gen/ts/src/nama/api/v1/playback_pb.js";
import { ProviderService } from "../../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import { SetupService } from "../../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import { SyncService } from "../../../../../gen/ts/src/nama/api/v1/sync_pb.js";
import { UserStateService } from "../../../../../gen/ts/src/nama/api/v1/user_state_pb.js";
import { connectPath } from "./connect-dispatch.test-support.ts";

const DUMMY_SIGN_IN_BODY = '{"email":"administrator@nama.test","password":"safe-test-password"}';

type RepresentativeRoute = Readonly<{
  readonly body: string;
  readonly expectsUnimplemented: boolean;
  readonly path: string;
}>;

type RepresentativeRouteInput = Readonly<{
  readonly body: string;
  readonly expectsUnimplemented?: boolean;
  readonly method: Readonly<{ readonly name: string }>;
  readonly service: Readonly<{ readonly typeName: string }>;
}>;

const route = ({
  body,
  expectsUnimplemented = false,
  method,
  service,
}: RepresentativeRouteInput): RepresentativeRoute => ({
  body,
  expectsUnimplemented,
  path: connectPath(service, method),
});

const connectProtocolProbePath = connectPath(SetupService, SetupService.method.getStatus);

const publicConnectRepresentativeRoutes: readonly RepresentativeRoute[] = Object.freeze([
  route({ body: "{}", method: SetupService.method.getStatus, service: SetupService }),
  route({ body: DUMMY_SIGN_IN_BODY, method: AuthService.method.signIn, service: AuthService }),
  route({
    body: "{}",
    expectsUnimplemented: true,
    method: HealthService.method.check,
    service: HealthService,
  }),
  route({ body: "{}", method: LibraryService.method.getHome, service: LibraryService }),
  route({ body: "{}", method: PlaybackService.method.planPlayback, service: PlaybackService }),
  route({
    body: "{}",
    method: ProviderService.method.listProviderTypes,
    service: ProviderService,
  }),
  route({ body: "{}", method: SyncService.method.getSyncStatus, service: SyncService }),
  route({ body: "{}", method: UserStateService.method.getUserState, service: UserStateService }),
]);

export { connectProtocolProbePath, publicConnectRepresentativeRoutes };

export type { RepresentativeRoute };
