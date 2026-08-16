import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Database } from "../../database/database.ts";
import { startServer } from "./http-server.test-support.ts";
import {
  EXPECTED_READINESS_TRANSITIONS,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  expectEmptyResponse,
} from "./network.test-support.ts";

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
    const states = [false, false, true, true];
    const messages: string[] = [];
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.sync(() => states.shift() ?? true),
        initialization: "setup-eligible",
      }),
      messages,
    );

    const live = yield* Effect.promise(() => fetch(`${server.origin}/health/live`));
    yield* expectEmptyResponse(live, HTTP_OK);
    yield* exerciseReadinessTransitions(server.origin);
    expect(messages.filter((message) => message === "database.readiness_changed")).toHaveLength(
      EXPECTED_READINESS_TRANSITIONS,
    );
  }),
);
