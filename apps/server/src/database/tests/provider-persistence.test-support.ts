import { Effect } from "effect";

import type { ProviderPersistence } from "../provider-persistence.ts";

const unexpectedPersistenceOperation = (description: string) => () => Effect.die(description);

const unusedProviderPersistence = Object.freeze({
  acceptInstallation: unexpectedPersistenceOperation(
    "unexpected provider installation persistence",
  ),
  createInstance: unexpectedPersistenceOperation("unexpected provider instance creation"),
  deleteInstance: unexpectedPersistenceOperation("unexpected provider instance deletion"),
  listInstallations: unexpectedPersistenceOperation("unexpected provider installation list"),
  listInstances: unexpectedPersistenceOperation("unexpected provider instance list"),
  loadInstallation: unexpectedPersistenceOperation("unexpected provider installation load"),
  loadInstallationConfigurations: unexpectedPersistenceOperation(
    "unexpected provider installation configuration load",
  ),
  loadInstance: unexpectedPersistenceOperation("unexpected provider instance load"),
  loadInstanceRecord: unexpectedPersistenceOperation("unexpected provider instance record load"),
  matchesPrincipal: unexpectedPersistenceOperation("unexpected provider principal comparison"),
  readOperationResult: unexpectedPersistenceOperation("unexpected provider operation-result read"),
  recordObservation: unexpectedPersistenceOperation("unexpected provider observation persistence"),
  updateInstance: unexpectedPersistenceOperation("unexpected provider instance update"),
}) satisfies ProviderPersistence;

export { unusedProviderPersistence };
