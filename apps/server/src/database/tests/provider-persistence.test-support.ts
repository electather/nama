import { Effect } from "effect";

import type { ProviderPersistence } from "../provider-persistence.ts";

// fallow-ignore-next-line code-duplication -- The complete fail-fast persistence double keeps every unexpected operation explicit.
const unusedProviderPersistence = Object.freeze({
  acceptInstallation: () => Effect.die("unexpected provider installation persistence"),
  createInstance: () => Effect.die("unexpected provider instance creation"),
  deleteInstance: () => Effect.die("unexpected provider instance deletion"),
  listInstallations: () => Effect.die("unexpected provider installation list"),
  listInstances: () => Effect.die("unexpected provider instance list"),
  loadInstallation: () => Effect.die("unexpected provider installation load"),
  loadInstallationConfigurations: () =>
    Effect.die("unexpected provider installation configuration load"),
  loadInstance: () => Effect.die("unexpected provider instance load"),
  // fallow-ignore-next-line code-duplication -- The complete fail-fast persistence double keeps every unexpected operation explicit.
  loadInstanceRecord: () => Effect.die("unexpected provider instance record load"),
  matchesPrincipal: () => Effect.die("unexpected provider principal comparison"),
  readOperationResult: () => Effect.die("unexpected provider operation-result read"),
  recordObservation: () => Effect.die("unexpected provider observation persistence"),
}) satisfies ProviderPersistence;

export { unusedProviderPersistence };
