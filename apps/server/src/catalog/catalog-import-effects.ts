import { Effect } from "effect";

const schedulingFailure = Effect.logWarning({ event: "catalog.scan_scheduling_failed" });

type Attempt<Success, Failure> =
  | Readonly<{ readonly kind: "failure"; readonly failure: Failure }>
  | Readonly<{ readonly kind: "success"; readonly success: Success }>;

const attempt = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Attempt<Success, Failure>, never, Requirements> =>
  effect.pipe(
    Effect.match({
      onFailure: (failure) => ({ failure, kind: "failure" as const }),
      onSuccess: (success) => ({ kind: "success" as const, success }),
    }),
  );

export { attempt, schedulingFailure };
export type { Attempt };
