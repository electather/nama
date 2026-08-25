import type { ConnectRouter } from "@connectrpc/connect";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { PlaybackService } from "@nama/api/nama/api/v1/playback_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { UserStateService } from "@nama/api/nama/api/v1/user_state_pb.js";

const registerUnimplementedConnectRoutes = (router: ConnectRouter): void => {
  router.service(HealthService, {});
  router.service(PlaybackService, {});
  router.service(SyncService, {});
  router.service(UserStateService, {});
};

export { registerUnimplementedConnectRoutes };
