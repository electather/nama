import { ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";

const jellyfinConfigurationSchema = {
  additionalProperties: false,
  properties: {
    api_key: {
      format: "password",
      maxLength: 4096,
      minLength: 1,
      title: "API key",
      type: "string",
      writeOnly: true,
      "x-nama-order": 3,
    },
    base_url: {
      format: "uri",
      maxLength: 2048,
      minLength: 1,
      title: "Base URL",
      type: "string",
      "x-nama-order": 1,
    },
    user_id: {
      maxLength: 128,
      minLength: 1,
      title: "User ID",
      type: "string",
      "x-nama-order": 2,
    },
  },
  required: ["base_url", "user_id", "api_key"],
  type: "object",
};

const jellyfinStockCapabilities = [
  ProviderCapability.LIBRARY_READ,
  ProviderCapability.ARTWORK_RESOLVE,
  ProviderCapability.WATCH_STATE_READ,
  ProviderCapability.WATCHED_WRITE,
];

const jellyfinPluginInfo = {
  buildVersion: "0.0.0-dev",
  capabilities: jellyfinStockCapabilities,
  configurationSchema: jellyfinConfigurationSchema,
  contractMajor: 1,
  description: "Connect Nama to a Jellyfin server.",
  displayName: "Jellyfin",
  providerTypeId: "jellyfin",
  schemaProfileVersion: 1,
  schemaRevision: "1",
};

export { jellyfinConfigurationSchema, jellyfinPluginInfo, jellyfinStockCapabilities };
