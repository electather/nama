import { fileURLToPath } from "node:url";

import type { PluginLaunchDescriptor } from "../plugin/model.ts";

interface BundledProvider {
  readonly descriptor: PluginLaunchDescriptor;
  readonly locatorOriginConfigurationProperties: readonly string[];
  readonly migratedRequiredProperties: readonly string[];
  readonly providerTypeId: string;
}
const EMPTY_LENGTH = 0;
const SAFE_PROPERTY_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

const jellyfinPluginPath = fileURLToPath(
  new URL("../../../../plugins/jellyfin/src/main.ts", import.meta.url),
);
const jellyfinArguments = Object.freeze([jellyfinPluginPath]);
const jellyfinStderrEvents = Object.freeze([]);
const jellyfinDescriptor: PluginLaunchDescriptor = Object.freeze({
  arguments: jellyfinArguments,
  executable: process.execPath,
  expectedProviderType: "jellyfin",
  stderrEvents: jellyfinStderrEvents,
});
const jellyfinLocatorOriginConfigurationProperties = Object.freeze(["base_url"]);
const jellyfinMigratedRequiredProperties = Object.freeze([]);
const jellyfinProvider: BundledProvider = Object.freeze({
  descriptor: jellyfinDescriptor,
  locatorOriginConfigurationProperties: jellyfinLocatorOriginConfigurationProperties,
  migratedRequiredProperties: jellyfinMigratedRequiredProperties,
  providerTypeId: "jellyfin",
});
const bundledProviders: readonly BundledProvider[] = Object.freeze([jellyfinProvider]);
const bundledProviderTypeIds: readonly string[] = Object.freeze(
  bundledProviders.map((provider) => provider.providerTypeId),
);
const hasValidPropertyNames = (properties: readonly string[]): boolean => {
  const names = new Set<string>();
  for (const property of properties) {
    if (!SAFE_PROPERTY_NAME.test(property) || names.has(property)) {
      return false;
    }
    names.add(property);
  }
  return true;
};

const validateBundledProviderRegistry = (): void => {
  const providerTypeIds = new Set<string>();
  for (const provider of bundledProviders) {
    if (
      !hasValidPropertyNames(provider.locatorOriginConfigurationProperties) ||
      !hasValidPropertyNames(provider.migratedRequiredProperties) ||
      provider.providerTypeId.length === EMPTY_LENGTH ||
      provider.descriptor.expectedProviderType !== provider.providerTypeId ||
      providerTypeIds.has(provider.providerTypeId)
    ) {
      throw new Error("invalid bundled provider registry");
    }
    providerTypeIds.add(provider.providerTypeId);
  }
};

export { bundledProviderTypeIds, bundledProviders, validateBundledProviderRegistry };
export type { BundledProvider };
