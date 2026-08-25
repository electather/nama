import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import type { CatalogPersistence } from "../../database/catalog-persistence.ts";
import { makeCatalogImport } from "../catalog-import.ts";
import type { CatalogImportDependencies } from "../catalog-import.ts";

const ZERO_RANDOM = 0;

const unexpected = <Success>(): Effect.Effect<Success> =>
  Effect.die("unexpected catalog persistence call");

const catalogWithSchedulerDefect = (): CatalogPersistence => ({
  acceptPage: () => unexpected(),
  beginScan: () => unexpected(),
  failScan: () => unexpected(),
  freshness: unexpected(),
  listScanCandidates: Effect.die("catalog scheduler defect"),
  loadItem: () => unexpected(),
  observeItem: () => unexpected(),
  pauseDisabledScans: () => Effect.void,
  resolvePageAcceptance: () => unexpected(),
  restartScan: () => unexpected(),
});

const runProviderActivity: CatalogImportDependencies["runProviderActivity"] = (
  _providerInstanceId,
  activity,
) => activity;

it.effect("reports an unexpected scheduler defect to the runtime owner", () =>
  Effect.scoped(
    Effect.gen(function* catalogSchedulerFailureTest() {
      const reported = yield* Deferred.make<unknown>();
      const importer = makeCatalogImport({
        catalog: catalogWithSchedulerDefect(),
        coreRunId: "core-run",
        listPage: () => unexpected(),
        random: () => ZERO_RANDOM,
        runProviderActivity,
      });

      yield* importer.start((cause: unknown) =>
        Deferred.succeed(reported, cause).pipe(Effect.as(true)),
      );

      expect(yield* Deferred.await(reported)).toBeDefined();
    }),
  ),
);
