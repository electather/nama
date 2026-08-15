import { Effect } from "effect";

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;

type HealthTarget = "/health/live" | "/health/ready";
type HealthStatus = typeof HTTP_OK | typeof HTTP_UNAVAILABLE;
type HealthStatusEffect = (accepting: boolean, target: HealthTarget) => Effect.Effect<HealthStatus>;

const makeHealthStatus = (checkReadiness: Effect.Effect<boolean>): HealthStatusEffect => {
  const state: { previous?: boolean } = {};
  const readinessProbe = checkReadiness.pipe(
    Effect.tap((ready) =>
      Effect.suspend(() => {
        if (state.previous === ready) {
          return Effect.void;
        }
        state.previous = ready;
        return Effect.log("database.readiness_changed");
      }),
    ),
  );

  return (accepting, target) => {
    if (target === "/health/live") {
      return Effect.succeed(HTTP_OK);
    }
    if (!accepting) {
      return Effect.succeed(HTTP_UNAVAILABLE);
    }
    return readinessProbe.pipe(
      Effect.map((ready) => {
        if (ready) {
          return HTTP_OK;
        }
        return HTTP_UNAVAILABLE;
      }),
    );
  };
};

export { makeHealthStatus };
export type { HealthStatus, HealthStatusEffect, HealthTarget };
