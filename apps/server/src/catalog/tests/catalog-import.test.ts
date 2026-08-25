import { create } from "@bufbuild/protobuf";
import { expect, it } from "@effect/vitest";
import { ListConsistency, ListItemsResponseSchema } from "@nama/api/nama/plugin/v1/library_pb.js";
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

it.live("reports an unexpected provider scan defect to the runtime owner", () =>
  Effect.scoped(
    Effect.gen(function* catalogScanFailureTest() {
      const reported = yield* Deferred.make<unknown>();
      const catalog: CatalogPersistence = {
        acceptPage: () => unexpected(),
        beginScan: () => Effect.die("provider scan defect"),
        failScan: () => unexpected(),
        listScanCandidates: Effect.succeed([
          { providerInstanceId: "provider-instance", revision: "provider-revision" },
        ]),
        loadItem: () => unexpected(),
        observeItem: () => unexpected(),
        pauseDisabledScans: () => Effect.void,
        resolvePageAcceptance: () => unexpected(),
        restartScan: () => unexpected(),
      };
      const importer = makeCatalogImport({
        catalog,
        coreRunId: "core-run",
        listPage: () => unexpected(),
        random: () => ZERO_RANDOM,
        runProviderActivity,
      });

      yield* importer.start((cause: unknown) =>
        Deferred.succeed(reported, cause).pipe(Effect.as(true)),
      );
      const observed = yield* Effect.raceFirst(
        Deferred.await(reported).pipe(Effect.as(true)),
        Effect.sleep(500).pipe(Effect.as(false)),
      );

      expect(observed).toBe(true);
    }),
  ),
);

it.live("keeps polling while an existing provider scan remains active", () =>
  Effect.scoped(
    Effect.gen(function* nonblockingCatalogSchedulerTest() {
      const firstEntered = yield* Deferred.make<void>();
      const firstRelease = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const completeResponse = create(ListItemsResponseSchema, {
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
      });
      let candidatePasses = 0;
      let secondProviderCalls = 0;
      const catalog: CatalogPersistence = {
        acceptPage: () => Effect.succeed("accepted"),
        beginScan: ({ providerInstanceId }) =>
          Effect.succeed({
            failureCount: 0,
            providerInstanceId,
            revision: `${providerInstanceId}-revision`,
          }),
        failScan: () => unexpected(),
        listScanCandidates: Effect.sync(() => {
          candidatePasses += 1;
          const first = { providerInstanceId: "first-provider", revision: "first-revision" };
          if (candidatePasses === 1) {
            return [first];
          }
          return [first, { providerInstanceId: "second-provider", revision: "second-revision" }];
        }),
        loadItem: () => unexpected(),
        observeItem: () => unexpected(),
        pauseDisabledScans: () => Effect.void,
        resolvePageAcceptance: () => unexpected(),
        restartScan: () => unexpected(),
      };
      const importer = makeCatalogImport({
        catalog,
        coreRunId: "core-run",
        listPage: ({ providerInstanceId }) => {
          if (providerInstanceId === "first-provider") {
            return Deferred.succeed(firstEntered, undefined).pipe(
              Effect.andThen(Deferred.await(firstRelease)),
              Effect.as(completeResponse),
            );
          }
          secondProviderCalls += 1;
          return Deferred.succeed(secondEntered, undefined).pipe(Effect.as(completeResponse));
        },
        random: () => ZERO_RANDOM,
        runProviderActivity,
      });

      yield* importer.start(() => Effect.succeed(true));
      yield* Deferred.await(firstEntered);

      const discovered = yield* Effect.raceFirst(
        Deferred.await(secondEntered).pipe(Effect.as(true)),
        Effect.sleep(1500).pipe(Effect.as(false)),
      );
      const candidatePassesWhileBlocked = candidatePasses;
      const secondProviderCallsWhileBlocked = secondProviderCalls;
      yield* Deferred.succeed(firstRelease, undefined);
      expect(candidatePassesWhileBlocked).toBeGreaterThanOrEqual(2);
      expect(secondProviderCallsWhileBlocked).toBe(1);
      expect(discovered).toBe(true);
    }),
  ),
);
