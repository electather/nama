import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { file_nama_api_v1_common as CommonApiNamespace } from "@nama/api/nama/api/v1/common_pb.js";
import { DeviceService } from "@nama/api/nama/api/v1/device_pb.js";
import { HealthService as HealthServiceApi } from "@nama/api/nama/api/v1/health_pb.js";
import { file_nama_api_v1_media as MediaApiNamespace } from "@nama/api/nama/api/v1/media_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { file_nama_plugin_v1_common as V1PluginCommonNamespace } from "@nama/api/nama/plugin/v1/common_pb.js";
import { HealthService as V1PluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";

export const contractNamespaces = {
  plugin: {
    common: V1PluginCommonNamespace,
    health: V1PluginHealthService,
  },
  public: {
    auth: AuthService,
    common: CommonApiNamespace,
    device: DeviceService,
    health: HealthServiceApi,
    media: MediaApiNamespace,
    provider: ProviderService,
    setup: SetupService,
    sync: SyncService,
  },
} as const;
