import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeHealthStatus } from "../health.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";
import {
  EXPECTED_READINESS_TRANSITIONS,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  expectEmptyResponse,
} from "./network.test-support.ts";

const NO_DATABASE_PROBES = 0;
const ONE_DATABASE_PROBE = 1;
const READINESS_SEQUENCE = [false, false, true, true] as const;

it.effect("fails readiness without probing the database until runtime control is ready", () =>
  Effect.gen(function* runtimeReadinessGateTest() {
    let probes = NO_DATABASE_PROBES;
    const healthStatus = makeHealthStatus(
      Effect.sync(() => {
        probes += ONE_DATABASE_PROBE;
        return true;
      }),
      Effect.succeed(false),
    );

    expect(yield* healthStatus(true, "/health/ready")).toBe(HTTP_UNAVAILABLE);
    expect(probes).toBe(NO_DATABASE_PROBES);
  }),
);

it.effect("probes database readiness only after runtime control becomes ready", () =>
  Effect.gen(function* runtimeReadinessTransitionTest() {
    let probes = NO_DATABASE_PROBES;
    let runtimeReady = false;
    const healthStatus = makeHealthStatus(
      Effect.sync(() => {
        probes += ONE_DATABASE_PROBE;
        return true;
      }),
      Effect.sync(() => runtimeReady),
    );

    expect(yield* healthStatus(true, "/health/ready")).toBe(HTTP_UNAVAILABLE);
    runtimeReady = true;
    expect(yield* healthStatus(true, "/health/ready")).toBe(HTTP_OK);
    expect(probes).toBe(ONE_DATABASE_PROBE);
  }),
);

const expectReadyResponse = (origin: string, status: number) =>
  Effect.promise(() => fetch(`${origin}/health/ready`)).pipe(
    Effect.flatMap((response) => expectEmptyResponse(response, status)),
  );

const exerciseReadinessTransitions = (origin: string) =>
  Effect.gen(function* readinessTransitions() {
    yield* expectReadyResponse(origin, HTTP_UNAVAILABLE);
    yield* expectReadyResponse(origin, HTTP_UNAVAILABLE);
    yield* expectReadyResponse(origin, HTTP_OK);
    yield* expectReadyResponse(origin, HTTP_OK);
  });

it.live("serves empty responses and logs only database readiness transitions", () =>
  Effect.gen(function* readinessLoggingTest() {
    const states = [...READINESS_SEQUENCE];
    const messages: string[] = [];
    const server = yield* startServer(
      makeDatabase(
        Effect.sync(() => {
          const state = states.shift();
          if (state === undefined) {
            throw new Error("unexpected database readiness probe");
          }
          return state;
        }),
      ),
      { messages },
    );

    const live = yield* Effect.promise(() => fetch(`${server.origin}/health/live`));
    yield* expectEmptyResponse(live, HTTP_OK);
    yield* exerciseReadinessTransitions(server.origin);
    expect(messages.filter((message) => message === "database.readiness_changed")).toHaveLength(
      EXPECTED_READINESS_TRANSITIONS,
    );
  }),
);
