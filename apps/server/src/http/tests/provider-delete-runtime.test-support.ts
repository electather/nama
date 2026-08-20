import { Effect } from "effect";

import type { ProviderPersistence } from "../../database/provider-persistence.ts";
import { makeProviderManagement } from "../../provider/provider-management.ts";
import type { ProviderManagementDependencies } from "../../provider/provider-management.ts";

const ABSENT_RESULT_BY_KEY: Readonly<Record<string, undefined>> = Object.freeze({});
const NO_DISCOVERY_RESULT = Effect.sync(() => ABSENT_RESULT_BY_KEY["discovery"]);

const makeProviderDeleteTestManagement = (
  persistence: ProviderPersistence,
  fenceInstance: ProviderManagementDependencies["fenceInstance"],
  masterKey: string,
) =>
  makeProviderManagement({
    discover: () => NO_DISCOVERY_RESULT,
    fenceInstance,
    masterKey,
    persistence,
  });

export { makeProviderDeleteTestManagement };
