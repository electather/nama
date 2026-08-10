import { HealthService as publicHealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { HealthService as pluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";

export const contractNamespaces = {
  public: publicHealthService,
  plugin: pluginHealthService,
} as const;
