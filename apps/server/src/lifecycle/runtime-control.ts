import { Context, Deferred, Effect, Layer } from "effect";

const contextService = Context.Service;

type RuntimeFailure = Readonly<{
  readonly _tag: "RuntimeFailure";
}>;

interface RuntimeControlService {
  readonly isReady: Effect.Effect<boolean>;
  readonly markReady: Effect.Effect<void>;
  readonly reportFatalFailure: (cause: unknown) => Effect.Effect<boolean>;
  readonly awaitFatalFailure: Effect.Effect<never, RuntimeFailure>;
}

const runtimeFailure: RuntimeFailure = Object.freeze({ _tag: "RuntimeFailure" });

const makeRuntimeControl = Effect.gen(function* makeRuntimeControlService() {
  let ready = false;
  let fatalFailureReported = false;
  const fatalFailure = yield* Deferred.make<never, RuntimeFailure>();

  const reportFatalFailure = (_cause: unknown) =>
    Effect.sync(() => {
      if (fatalFailureReported) {
        return false;
      }

      fatalFailureReported = true;
      ready = false;
      return Deferred.doneUnsafe(fatalFailure, Effect.fail(runtimeFailure));
    });

  return RuntimeControl.of({
    awaitFatalFailure: Deferred.await(fatalFailure),
    isReady: Effect.sync(() => ready),
    markReady: Effect.sync(() => {
      if (!fatalFailureReported) {
        ready = true;
      }
    }),
    reportFatalFailure,
  });
});

class RuntimeControl extends contextService<RuntimeControl, RuntimeControlService>()(
  "@nama/server/RuntimeControl",
) {
  static readonly layer = Layer.effect(RuntimeControl, makeRuntimeControl);
}

export { RuntimeControl };
