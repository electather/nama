// oxlint-disable eslint/max-lines, eslint/no-magic-numbers, eslint/sort-imports, eslint/sort-keys -- Literal replay fixtures keep inputs and expected outcomes adjacent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { replayWatchState } from "./watch-state-reconciliation.ts";
import type { ProviderSource, ReplayEvent } from "./watch-state-reconciliation.ts";

const providers = [
  { id: "primary", priority: 1 },
  { id: "secondary", priority: 2 },
] as const satisfies readonly ProviderSource[];

void test("reliable provider activity uses the newest timestamp", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 100,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "secondary",
      reliability: "reliable",
      activityAt: 300,
      state: { watched: false, positionMs: 300, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 200,
      state: { watched: false, positionMs: 200, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: 300,
    priority: 2,
    reliableActivity: true,
    sourceId: "secondary",
    state: { watched: false, positionMs: 300, durationMs: 1000 },
    version: 2,
  });
});

void test("an older reliable observation from the same provider cannot regress canonical state", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 300,
      state: { watched: false, positionMs: 300, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 200,
      state: { watched: false, positionMs: 200, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: 300,
    priority: 1,
    reliableActivity: true,
    sourceId: "primary",
    state: { watched: false, positionMs: 300, durationMs: 1000 },
    version: 1,
  });
  assert.deepEqual(result.exports, [
    {
      canonicalVersion: 1,
      providerId: "secondary",
      state: { watched: false, positionMs: 300, durationMs: 1000 },
    },
    {
      canonicalVersion: 1,
      providerId: "primary",
      state: { watched: false, positionMs: 300, durationMs: 1000 },
    },
  ]);
});

void test("a newer reliable activity preserves genuine backward rewatch progress", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 100,
      state: { watched: true, positionMs: 900, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "secondary",
      reliability: "reliable",
      activityAt: 200,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: 200,
    priority: 2,
    reliableActivity: true,
    sourceId: "secondary",
    state: { watched: false, positionMs: 100, durationMs: 1000 },
    version: 2,
  });
});

void test("provider priority replaces time comparison when activity time is unreliable", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "secondary",
      reliability: "reliable",
      activityAt: 500,
      state: { watched: false, positionMs: 500, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "heuristic",
      activityAt: 900,
      state: { watched: false, positionMs: 50, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: undefined,
    priority: 1,
    reliableActivity: false,
    sourceId: "primary",
    state: { watched: false, positionMs: 50, durationMs: 1000 },
    version: 2,
  });
});

void test("later untimestamped observations from one provider replace its prior replica", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "missing",
      activityAt: undefined,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "missing",
      activityAt: undefined,
      state: { watched: false, positionMs: 250, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: undefined,
    priority: 1,
    reliableActivity: false,
    sourceId: "primary",
    state: { watched: false, positionMs: 250, durationMs: 1000 },
    version: 2,
  });
});

void test("lower numeric provider priority breaks exact reliable timestamp ties", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "secondary",
      reliability: "reliable",
      activityAt: 100,
      state: { watched: false, positionMs: 200, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 100,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: 100,
    priority: 1,
    reliableActivity: true,
    sourceId: "primary",
    state: { watched: false, positionMs: 100, durationMs: 1000 },
    version: 2,
  });
});

void test("duplicate provider observations do not create another canonical version or export", () => {
  const observation = {
    type: "provider-observation",
    providerId: "primary",
    reliability: "reliable",
    activityAt: 100,
    state: { watched: false, positionMs: 100, durationMs: 1000 },
  } as const satisfies ReplayEvent;

  const result = replayWatchState(providers, [observation, observation]);

  assert.equal(result.canonical?.version, 1);
  assert.deepEqual(result.exports, [
    {
      canonicalVersion: 1,
      providerId: "secondary",
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
  ]);
});

void test("retrying one Nama operation is idempotent", () => {
  const action = {
    type: "nama-action",
    operationId: "operation-1",
    activityAt: 100,
    state: { watched: false, positionMs: 400, durationMs: 1000 },
  } as const satisfies ReplayEvent;

  const result = replayWatchState(providers, [action, action]);

  assert.equal(result.canonical?.version, 1);
  assert.deepEqual(result.exports, [
    {
      canonicalVersion: 1,
      providerId: "primary",
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      canonicalVersion: 1,
      providerId: "secondary",
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
  ]);
});

void test("only an exact confirmed export echo is suppressed", () => {
  const events = [
    {
      type: "nama-action",
      operationId: "operation-1",
      activityAt: 100,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-export-confirmed",
      providerId: "primary",
      canonicalVersion: 1,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 1000,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 1100,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.equal(result.suppressedEchoes, 1);
  assert.deepEqual(result.canonical, {
    activityAt: 1100,
    priority: 1,
    reliableActivity: true,
    sourceId: "primary",
    state: { watched: false, positionMs: 100, durationMs: 1000 },
    version: 2,
  });
  assert.deepEqual(result.exports.at(-1), {
    canonicalVersion: 2,
    providerId: "secondary",
    state: { watched: false, positionMs: 100, durationMs: 1000 },
  });
});

void test("retrying an export confirmation does not re-arm a consumed echo", () => {
  const events = [
    {
      type: "nama-action",
      operationId: "operation-1",
      activityAt: 100,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-export-confirmed",
      providerId: "primary",
      canonicalVersion: 1,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 1000,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-export-confirmed",
      providerId: "primary",
      canonicalVersion: 1,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 1100,
      state: { watched: false, positionMs: 400, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.equal(result.suppressedEchoes, 1);
  assert.deepEqual(result.canonical, {
    activityAt: 1100,
    priority: 1,
    reliableActivity: true,
    sourceId: "primary",
    state: { watched: false, positionMs: 400, durationMs: 1000 },
    version: 2,
  });
});

void test("provider export confirmations update replicas without replacing canonical state", () => {
  const events = [
    {
      type: "provider-observation",
      providerId: "primary",
      reliability: "reliable",
      activityAt: 100,
      state: { watched: false, positionMs: 100, durationMs: 1000 },
    },
    {
      type: "nama-action",
      operationId: "operation-1",
      activityAt: 200,
      state: { watched: false, positionMs: 500, durationMs: 1000 },
    },
    {
      type: "provider-export-confirmed",
      providerId: "primary",
      canonicalVersion: 2,
      state: { watched: false, positionMs: 500, durationMs: 1000 },
    },
    {
      type: "provider-export-confirmed",
      providerId: "secondary",
      canonicalVersion: 2,
      state: { watched: false, positionMs: 500, durationMs: 1000 },
    },
  ] as const satisfies readonly ReplayEvent[];

  const result = replayWatchState(providers, events);

  assert.deepEqual(result.canonical, {
    activityAt: 200,
    priority: 0,
    reliableActivity: true,
    sourceId: "nama",
    state: { watched: false, positionMs: 500, durationMs: 1000 },
    version: 2,
  });
  assert.deepEqual(result.providerStates, {
    primary: { watched: false, positionMs: 500, durationMs: 1000 },
    secondary: { watched: false, positionMs: 500, durationMs: 1000 },
  });
});
