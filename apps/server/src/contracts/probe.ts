// oxlint-disable import/max-dependencies -- This compile probe intentionally imports every contract namespace.
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { file_nama_api_v1_common as CommonApiNamespace } from "@nama/api/nama/api/v1/common_pb.js";
import { DeviceService } from "@nama/api/nama/api/v1/device_pb.js";
import { HealthService as HealthServiceApi } from "@nama/api/nama/api/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/api/v1/library_pb.js";
import { file_nama_api_v1_media as MediaApiNamespace } from "@nama/api/nama/api/v1/media_pb.js";
import { PlaybackService } from "@nama/api/nama/api/v1/playback_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { UserStateService } from "@nama/api/nama/api/v1/user_state_pb.js";
import { file_nama_plugin_v1_common as V1PluginCommonNamespace } from "@nama/api/nama/plugin/v1/common_pb.js";
import { HealthService as V1PluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService as V1PluginLibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { PlaybackService as V1PluginPlaybackService } from "@nama/api/nama/plugin/v1/playback_pb.js";
import { PluginService as V1PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { WatchStateService as V1PluginWatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

export const contractNamespaces = {
  plugin: {
    common: V1PluginCommonNamespace,
    health: V1PluginHealthService,
    library: V1PluginLibraryService,
    playback: V1PluginPlaybackService,
    plugin: V1PluginService,
    watchState: V1PluginWatchStateService,
  },
  public: {
    auth: AuthService,
    common: CommonApiNamespace,
    device: DeviceService,
    health: HealthServiceApi,
    library: LibraryService,
    media: MediaApiNamespace,
    playback: PlaybackService,
    provider: ProviderService,
    setup: SetupService,
    sync: SyncService,
    userState: UserStateService,
  },
} as const;
