import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/api/v1/library_pb.js";
import { PlaybackService } from "@nama/api/nama/api/v1/playback_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { UserStateService } from "@nama/api/nama/api/v1/user_state_pb.js";

const publicServices = [
  AuthService,
  HealthService,
  LibraryService,
  PlaybackService,
  ProviderService,
  SetupService,
  SyncService,
  UserStateService,
] as const;

export { publicServices };
