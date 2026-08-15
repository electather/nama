import { HealthService as PluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService as PluginLibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { PlaybackService as PluginPlaybackService } from "@nama/api/nama/plugin/v1/playback_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { WatchStateService as PluginWatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

const pluginServices = [
  PluginHealthService,
  PluginLibraryService,
  PluginPlaybackService,
  PluginService,
  PluginWatchStateService,
] as const;

export { pluginServices };
