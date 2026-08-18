import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect";

import { PluginSupervisor } from "../../src/plugins/plugin-supervisor.ts";
import type {
  PluginLaunchDescriptor,
  PluginSupervisorError,
} from "../../src/plugins/plugin-supervisor.ts";

const FIXTURE = join(import.meta.dirname, "../fixtures/plugin-fixture.mjs");
const ONE_SECOND = 1000;
const SHORT_DEADLINE = 50;
const ONE_HUNDRED_FIFTY_MILLISECONDS = 150;
const TWO_SECONDS = 2000;
const PLUGIN_CONTRACT_MAJOR = 1;
const PLUGIN_UNAVAILABLE_REASON = "RECOVERY_EXHAUSTED";

const descriptor = (...fixtureArguments: readonly string[]): PluginLaunchDescriptor => ({
  args: [FIXTURE, ...fixtureArguments],
  executable: process.execPath,
  providerTypeId: "fixture",
});

const stderrDescriptor = (): PluginLaunchDescriptor => ({
  ...descriptor("--stderr"),
  stderrEvents: {
    "fixture.connected": {
      fields: { attempt: { kind: "number" } },
      levels: ["info"],
    },
  },
});

const missingExecutableDescriptor = (): PluginLaunchDescriptor => ({
  ...descriptor(),
  executable: join(import.meta.dirname, "../fixtures/missing-plugin.mjs"),
});

const withSupervisor = <Value>(
  use: (
    supervisor: PluginSupervisor["Service"],
    records: readonly unknown[],
  ) => Effect.Effect<Value, PluginSupervisorError>,
): Effect.Effect<Value, PluginSupervisorError> =>
  Effect.gen(function* withSupervisorEffect() {
    const records: unknown[] = [];
    const capture = Logger.make<unknown, void>(({ message }) => {
      records.push(message);
    });
    const scope = yield* Scope.make();
    const loggerLayer = Logger.layer([capture]);
    const supervisorLayer = PluginSupervisor.layer().pipe(Layer.provide(loggerLayer));
    const context = yield* Layer.buildWithScope(supervisorLayer, scope);
    const supervisor = Context.get(context, PluginSupervisor);
    const result = yield* Effect.exit(use(supervisor, records));
    yield* Scope.close(scope, Exit.void);
    return yield* result;
  });
const expectFailureReason = (
  result: Exit.Exit<unknown, PluginSupervisorError>,
  expectedReason: string,
): void => {
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const failure = result.cause.reasons.find(Cause.isFailReason);
    expect(failure?.error.reason).toBe(expectedReason);
  }
};
it.live("launches a real authenticated Unix-socket plugin and verifies identity", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* launchFixtureEffect() {
        const plugin = yield* supervisor.acquire(descriptor());
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        expect(response.pluginInfo?.contractMajor).toBe(PLUGIN_CONTRACT_MAJOR);
      }),
    ),
  ),
);

it.live("rejects a plugin that advertises the wrong provider type", () =>
  withSupervisor((supervisor) =>
    Effect.gen(function* rejectWrongProviderEffect() {
      const acquisition = supervisor.acquire(descriptor("--wrong-provider"));
      const result = yield* Effect.exit(Effect.scoped(acquisition));
      expectFailureReason(result, "PROVIDER_TYPE_MISMATCH");
    }),
  ),
);

it.live("rejects an unsupported plugin contract major without retrying", () =>
  withSupervisor((supervisor) =>
    Effect.gen(function* rejectWrongMajorEffect() {
      const acquisition = supervisor.acquire(descriptor("--wrong-major"));
      const result = yield* Effect.exit(Effect.scoped(acquisition));
      expectFailureReason(result, "CONTRACT_MAJOR_UNSUPPORTED");
    }),
  ),
);

it.live("rejects a missing executable before launch", () =>
  withSupervisor((supervisor) =>
    Effect.gen(function* rejectMissingExecutableEffect() {
      const acquisition = supervisor.acquire(missingExecutableDescriptor());
      const result = yield* Effect.exit(Effect.scoped(acquisition));
      expectFailureReason(result, "EXECUTABLE_UNAVAILABLE");
    }),
  ),
);

it.live("bounds premature process exit recovery", () =>
  withSupervisor((supervisor) =>
    Effect.gen(function* rejectPrematureExitEffect() {
      const acquisition = supervisor.acquire(descriptor("--exit-before-socket"));
      const result = yield* Effect.exit(Effect.scoped(acquisition));
      expectFailureReason(result, PLUGIN_UNAVAILABLE_REASON);
    }),
  ),
);

it.live("keeps the core boundary alive after an unexpected plugin exit", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* recoverUnexpectedExitEffect() {
        const plugin = yield* supervisor.acquire(descriptor("--crash-after-ready"));
        yield* Effect.sleep(`${ONE_HUNDRED_FIFTY_MILLISECONDS} millis`);
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        expect(response.pluginInfo?.providerTypeId).toBe("fixture");
      }),
    ),
  ),
);

it.live("does not inherit ambient environment or launch secrets", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* verifyEnvironmentIsolationEffect() {
        const plugin = yield* supervisor.acquire(descriptor("--env-probe"));
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        expect(response.pluginInfo?.description).toBe("");
      }),
    ),
  ),
);

it.live("accepts declared stderr and rejects raw stderr", () =>
  withSupervisor((supervisor, records) =>
    Effect.scoped(
      Effect.gen(function* verifyStderrBoundaryEffect() {
        const plugin = yield* supervisor.acquire(stderrDescriptor());
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        yield* Effect.sleep(`${SHORT_DEADLINE} millis`);
        expect(response.pluginInfo?.providerTypeId).toBe("fixture");
        expect(records).toContainEqual([
          expect.objectContaining({
            event: "fixture.connected",
            pluginFields: { attempt: 1 },
          }),
        ]);
        expect(records.flat()).not.toContain("raw provider failure");
      }),
    ),
  ),
);

it.live("recycles a process after an RPC deadline", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* recycleAfterDeadlineEffect() {
        const plugin = yield* supervisor.acquire(descriptor("--block-call"));
        const result = yield* Effect.exit(
          plugin.clients.plugin.getConnection({}, { timeoutMs: SHORT_DEADLINE }),
        );
        expectFailureReason(result, "DEADLINE_EXCEEDED");
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        expect(response.pluginInfo?.providerTypeId).toBe("fixture");
      }),
    ),
  ),
);

it.live("cancelling one RPC leaves sibling plugin work healthy", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* preserveSiblingEffect() {
        const plugin = yield* supervisor.acquire(descriptor("--block-call"));
        const blocked = yield* Effect.forkChild(
          plugin.clients.plugin.getConnection({}, { timeoutMs: TWO_SECONDS }),
        );
        yield* Effect.sleep(`${SHORT_DEADLINE} millis`);
        yield* Fiber.interrupt(blocked);
        const response = yield* plugin.clients.plugin.getInfo({}, { timeoutMs: ONE_SECOND });
        expect(response.pluginInfo?.providerTypeId).toBe("fixture");
      }),
    ),
  ),
);
it.live("escalates a stubborn plugin during scope shutdown", () =>
  withSupervisor((supervisor) =>
    Effect.scoped(
      Effect.gen(function* shutdownStubbornEffect() {
        yield* supervisor.acquire(descriptor("--stubborn"));
      }),
    ),
  ),
);
