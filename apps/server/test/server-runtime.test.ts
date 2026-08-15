import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Layer, ManagedRuntime as ManagedRuntimeApi } from "effect";
import { vi } from "vitest";

import { Database } from "../src/database.ts";
import { startServer } from "./server.test-support.ts";

const FIRST_RUNTIME_INDEX = 0;

interface DisposalProbe {
  disposed: boolean;
}

interface ManagedRuntimeExports {
  readonly make: <Requirements, Error>(
    layer: Layer.Layer<Requirements, Error>,
    options?: { readonly memoMap?: Layer.MemoMap | undefined },
  ) => ManagedRuntimeApi.ManagedRuntime<Requirements, Error>;
}

interface EffectExports {
  readonly Effect: typeof Effect;
  readonly ManagedRuntime: ManagedRuntimeExports;
  readonly [name: string]: unknown;
}

const disposalProbes = vi.hoisted((): DisposalProbe[] => []);

vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<EffectExports>();
  const makeManagedRuntime: ManagedRuntimeExports["make"] = (layer, options) => {
    const runtime = actual.ManagedRuntime.make(layer, options);
    const probe: DisposalProbe = { disposed: false };
    disposalProbes.push(probe);
    return {
      ...runtime,
      disposeEffect: runtime.disposeEffect.pipe(
        actual.Effect.tap(() =>
          actual.Effect.sync(() => {
            probe.disposed = true;
          }),
        ),
      ),
    };
  };
  return {
    ...actual,
    ManagedRuntime: {
      ...actual.ManagedRuntime,
      make: makeManagedRuntime,
    },
  };
});

it.live("disposes the managed runtime when the server scope closes", () =>
  Effect.gen(function* managedRuntimeDisposalTest() {
    const database = Database.of({ checkReadiness: Effect.succeed(true) });
    const server = yield* startServer(database);

    yield* server.close;

    expect(disposalProbes.at(FIRST_RUNTIME_INDEX)?.disposed).toBe(true);
  }),
);
