import { HealthService as apiHealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { HealthService as pluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";

export const contractNamespaces = {
  plugin: pluginHealthService,
  public: apiHealthService,
} as const;
