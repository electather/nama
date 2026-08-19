// oxlint-disable eslint/no-magic-numbers, eslint/sort-keys, typescript/no-non-null-assertion -- Restricted-schema tables keep wire values and incompatible mutations explicit.
import { expect, it } from "@effect/vitest";

import {
  configurationMatchesRestrictedSchema,
  isInstallationSchemaCompatible,
  normalizeDiscoveredPluginInfo,
} from "../restricted-schema.ts";

const jellyfinSchema = {
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
} as const;

const pluginInfo = (configurationSchema: Readonly<Record<string, unknown>> = jellyfinSchema) => ({
  buildVersion: "0.0.0-dev",
  capabilities: [1, 99],
  configurationSchema,
  contractMajor: 1,
  description: "Connect Nama to a Jellyfin server.",
  displayName: "Jellyfin",
  providerTypeId: "jellyfin",
  schemaProfileVersion: 1,
  schemaRevision: "1",
});

it("accepts and normalizes the restricted Jellyfin discovery schema", () => {
  expect(normalizeDiscoveredPluginInfo(pluginInfo(), "jellyfin")).toEqual({
    pluginBuildVersion: "0.0.0-dev",
    capabilities: [1],
    configurationSchema: jellyfinSchema,
    contractMajor: 1,
    description: "Connect Nama to a Jellyfin server.",
    displayName: "Jellyfin",
    providerTypeId: "jellyfin",
    schemaProfileVersion: 1,
    schemaRevision: "1",
  });
});

it("rejects unsupported schema shapes and unsafe secret declarations", () => {
  const invalidSchemas = [
    { ...jellyfinSchema, patternProperties: {} },
    {
      ...jellyfinSchema,
      properties: { nested: { additionalProperties: false, properties: {}, type: "object" } },
      required: [],
    },
    {
      ...jellyfinSchema,
      properties: {
        ...jellyfinSchema.properties,
        api_key: { ...jellyfinSchema.properties.api_key, default: "reusable-secret" },
      },
    },
    {
      ...jellyfinSchema,
      properties: { invalid_name_: { type: "string" } },
      required: [],
    },
    {
      ...jellyfinSchema,
      properties: {
        region: {
          enum: Array.from({ length: 101 }, (unusedValue, index) => {
            void unusedValue;
            return `region-${index}`;
          }),
          type: "string",
        },
      },
      required: [],
    },
    {
      ...jellyfinSchema,
      description: "x".repeat(65_537),
    },
  ];
  for (const schema of invalidSchemas) {
    expect(normalizeDiscoveredPluginInfo(pluginInfo(schema), "jellyfin")).toBeUndefined();
  }
});

it("rejects malformed metadata, capabilities, and schema profile versions", () => {
  expect(
    normalizeDiscoveredPluginInfo({ ...pluginInfo(), providerTypeId: "other" }, "jellyfin"),
  ).toBeUndefined();
  expect(
    normalizeDiscoveredPluginInfo({ ...pluginInfo(), schemaProfileVersion: 2 }, "jellyfin"),
  ).toBeUndefined();
  expect(
    normalizeDiscoveredPluginInfo({ ...pluginInfo(), capabilities: [0] }, "jellyfin"),
  ).toBeUndefined();
  expect(
    normalizeDiscoveredPluginInfo({ ...pluginInfo(), capabilities: [1, 1] }, "jellyfin"),
  ).toBeUndefined();
});

it("accepts additive optional schema growth and looser constraints", () => {
  const previous = normalizeDiscoveredPluginInfo(pluginInfo(), "jellyfin");
  const next = normalizeDiscoveredPluginInfo(
    {
      ...pluginInfo({
        ...jellyfinSchema,
        properties: {
          ...jellyfinSchema.properties,
          base_url: { ...jellyfinSchema.properties.base_url, maxLength: 4096 },
          label: { maxLength: 64, type: "string" },
        },
      }),
      schemaRevision: "2",
    },
    "jellyfin",
  );
  expect(previous).toBeDefined();
  expect(next).toBeDefined();
  expect(isInstallationSchemaCompatible(previous!, next!, [])).toBe(true);
});

it("rejects schema revisions that reinterpret or invalidate accepted properties", () => {
  const previous = normalizeDiscoveredPluginInfo(pluginInfo(), "jellyfin");
  expect(previous).toBeDefined();
  const incompatibleSchemas = [
    {
      ...jellyfinSchema,
      properties: {
        api_key: jellyfinSchema.properties.api_key,
        base_url: jellyfinSchema.properties.base_url,
      },
      required: ["base_url", "api_key"],
    },
    {
      ...jellyfinSchema,
      properties: {
        ...jellyfinSchema.properties,
        api_key: { ...jellyfinSchema.properties.api_key, writeOnly: false },
      },
    },
    {
      ...jellyfinSchema,
      properties: {
        ...jellyfinSchema.properties,
        base_url: { ...jellyfinSchema.properties.base_url, maxLength: 1024 },
      },
    },
  ];
  for (const configurationSchema of incompatibleSchemas) {
    const next = normalizeDiscoveredPluginInfo(
      { ...pluginInfo(configurationSchema), schemaRevision: "2" },
      "jellyfin",
    );
    expect(next).toBeDefined();
    expect(isInstallationSchemaCompatible(previous!, next!, [])).toBe(false);
  }
});

it("requires code-owned authorization before validating a newly required property", () => {
  const previous = normalizeDiscoveredPluginInfo(pluginInfo(), "jellyfin");
  const migratedSchema = {
    ...jellyfinSchema,
    properties: { ...jellyfinSchema.properties, region: { type: "string" } },
    required: [...jellyfinSchema.required, "region"],
  };
  const next = normalizeDiscoveredPluginInfo(
    { ...pluginInfo(migratedSchema), schemaRevision: "2" },
    "jellyfin",
  );
  expect(previous).toBeDefined();
  expect(next).toBeDefined();
  expect(isInstallationSchemaCompatible(previous!, next!, [])).toBe(false);
  expect(isInstallationSchemaCompatible(previous!, next!, ["region"])).toBe(true);
});

it("treats JSON object key order as irrelevant to a repeated schema revision", () => {
  const previous = normalizeDiscoveredPluginInfo(pluginInfo(), "jellyfin");
  const reorderedSchema = {
    type: "object",
    required: ["base_url", "user_id", "api_key"],
    properties: {
      user_id: jellyfinSchema.properties.user_id,
      base_url: jellyfinSchema.properties.base_url,
      api_key: jellyfinSchema.properties.api_key,
    },
    additionalProperties: false,
  };
  const next = normalizeDiscoveredPluginInfo(pluginInfo(reorderedSchema), "jellyfin");
  expect(previous).toBeDefined();
  expect(next).toBeDefined();
  expect(isInstallationSchemaCompatible(previous!, next!, [])).toBe(true);
});

it("validates complete stored configuration with UTF-8 byte bounds", () => {
  expect(
    configurationMatchesRestrictedSchema(jellyfinSchema, {
      api_key: "credential",
      base_url: "https://jellyfin.example.test/",
      user_id: "provider-user",
    }),
  ).toBe(true);
  expect(
    configurationMatchesRestrictedSchema(jellyfinSchema, {
      api_key: "credential",
      base_url: "https://jellyfin.example.test/",
    }),
  ).toBe(false);
  expect(
    configurationMatchesRestrictedSchema(jellyfinSchema, {
      api_key: "é".repeat(2049),
      base_url: "https://jellyfin.example.test/",
      user_id: "provider-user",
    }),
  ).toBe(false);
  expect(
    configurationMatchesRestrictedSchema(jellyfinSchema, {
      api_key: "credential",
      base_url: "relative",
      user_id: "provider-user",
    }),
  ).toBe(false);
});
