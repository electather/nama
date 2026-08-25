// oxlint-disable eslint/max-lines-per-function, eslint/max-statements -- The scheduler state-machine scenarios keep concurrent transitions and their assertions visible in execution order.
import { create } from "@bufbuild/protobuf";
import { expect, it } from "@effect/vitest";
import { ListConsistency, ListItemsResponseSchema } from "@nama/api/nama/plugin/v1/library_pb.js";
import { Deferred, Effect } from "effect";

import type { CatalogPersistence } from "../../database/catalog-persistence.ts";
import { makeCatalogImport } from "../catalog-import.ts";
import type { CatalogImportDependencies } from "../catalog-import.ts";

const ZERO = 0;
const ZERO_RANDOM = ZERO;
const COUNT_INCREMENT = 1;
const FIRST_CANDIDATE_PASS = 1;
const EXPECTED_CANDIDATE_PASSES = 2;
const EXPECTED_SECOND_PROVIDER_CALLS = 1;
const FAILURE_OBSERVATION_WAIT_MILLISECONDS = 500;
const PROVIDER_DISCOVERY_WAIT_MILLISECONDS = 1500;

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
        Effect.sleep(FAILURE_OBSERVATION_WAIT_MILLISECONDS).pipe(Effect.as(false)),
      );

      expect(observed).toBe(true);
    }),
  ),
);

it.live("keeps polling while an existing provider scan remains active", () =>
  Effect.scoped(
    Effect.gen(function* nonblockingCatalogSchedulerTest() {
      const firstEntered = yield* Deferred.make<boolean>();
      const firstRelease = yield* Deferred.make<boolean>();
      const secondEntered = yield* Deferred.make<boolean>();
      const completeResponse = create(ListItemsResponseSchema, {
        complete: true,
        consistency: ListConsistency.BEST_EFFORT_SCAN,
      });
      let candidatePasses = ZERO;
      let secondProviderCalls = ZERO;
      const catalog: CatalogPersistence = {
        acceptPage: () => Effect.succeed("accepted"),
        beginScan: ({ providerInstanceId }) =>
          Effect.succeed({
            failureCount: ZERO,
            providerInstanceId,
            revision: `${providerInstanceId}-revision`,
          }),
        failScan: () => unexpected(),
        listScanCandidates: Effect.sync(() => {
          candidatePasses += COUNT_INCREMENT;
          const first = { providerInstanceId: "first-provider", revision: "first-revision" };
          if (candidatePasses === FIRST_CANDIDATE_PASS) {
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
            return Deferred.succeed(firstEntered, true).pipe(
              Effect.andThen(Deferred.await(firstRelease)),
              Effect.as(completeResponse),
            );
          }
          secondProviderCalls += COUNT_INCREMENT;
          return Deferred.succeed(secondEntered, true).pipe(Effect.as(completeResponse));
        },
        random: () => ZERO_RANDOM,
        runProviderActivity,
      });

      yield* importer.start(() => Effect.succeed(true));
      yield* Deferred.await(firstEntered);

      const discovered = yield* Effect.raceFirst(
        Deferred.await(secondEntered).pipe(Effect.as(true)),
        Effect.sleep(PROVIDER_DISCOVERY_WAIT_MILLISECONDS).pipe(Effect.as(false)),
      );
      const candidatePassesWhileBlocked = candidatePasses;
      const secondProviderCallsWhileBlocked = secondProviderCalls;
      yield* Deferred.succeed(firstRelease, true);
      expect(candidatePassesWhileBlocked).toBeGreaterThanOrEqual(EXPECTED_CANDIDATE_PASSES);
      expect(secondProviderCallsWhileBlocked).toBe(EXPECTED_SECOND_PROVIDER_CALLS);
      expect(discovered).toBe(true);
    }),
  ),
);
