import { Effect } from "effect";

import type { ProviderPersistence } from "../provider-persistence.ts";

const unusedProviderPersistence = Object.freeze({
  acceptInstallation: () => Effect.die("unexpected provider installation persistence"),
  createInstance: () => Effect.die("unexpected provider instance creation"),
  deleteInstance: () => Effect.die("unexpected provider instance deletion"),
  listInstallations: () => Effect.die("unexpected provider installation list"),
  loadInstallation: () => Effect.die("unexpected provider installation load"),
  loadInstallationConfigurations: () =>
    Effect.die("unexpected provider installation configuration load"),
  loadInstance: () => Effect.die("unexpected provider instance load"),
  matchesPrincipal: () => Effect.die("unexpected provider principal comparison"),
  readOperationResult: () => Effect.die("unexpected provider operation-result read"),
  recordObservation: () => Effect.die("unexpected provider observation persistence"),
}) satisfies ProviderPersistence;

export { unusedProviderPersistence };
