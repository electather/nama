import { HealthService as PluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";

const pluginContract = PluginHealthService;
const pluginIdentityContract = PluginService;

export { pluginContract, pluginIdentityContract };
