import type { ConnectRouter } from "@connectrpc/connect";

import { DeviceService } from "../../../../gen/ts/src/nama/api/v1/device_pb.js";
import { HealthService } from "../../../../gen/ts/src/nama/api/v1/health_pb.js";
import { LibraryService } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import { PlaybackService } from "../../../../gen/ts/src/nama/api/v1/playback_pb.js";
import { ProviderService } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import { SyncService } from "../../../../gen/ts/src/nama/api/v1/sync_pb.js";
import { UserStateService } from "../../../../gen/ts/src/nama/api/v1/user_state_pb.js";

const registerUnimplementedConnectRoutes = (router: ConnectRouter): void => {
  router.service(DeviceService, {});
  router.service(HealthService, {});
  router.service(LibraryService, {});
  router.service(PlaybackService, {});
  router.service(ProviderService, {});
  router.service(SyncService, {});
  router.service(UserStateService, {});
};

export { registerUnimplementedConnectRoutes };
