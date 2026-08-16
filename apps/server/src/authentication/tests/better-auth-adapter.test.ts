import { it } from "@effect/vitest";
import { Effect } from "effect";

import { makeBetterAuthAdapter } from "../better-auth-adapter.ts";
import {
  MASTER_KEY,
  PRIVATE_PROPERTY,
  expectDrizzleAdapterConfiguration,
  expectModuleLoading,
  expectRuntimeConfiguration,
  expectSafeConstructionFailure,
  expectedSecret,
  makeInput,
  makePrivateError,
  makeRuntimeFakes,
  requireRuntimeModule,
} from "./better-auth-adapter-construction.test-support.ts";

interface InvalidExportCase {
  readonly exportName: string;
  readonly kind: "missing" | "non-callable";
  readonly moduleId: string;
}

const invalidExportCases = [
  { exportName: "betterAuth", kind: "missing", moduleId: "better-auth" },
  { exportName: "betterAuth", kind: "non-callable", moduleId: "better-auth" },
  {
    exportName: "drizzleAdapter",
    kind: "missing",
    moduleId: "better-auth/adapters/drizzle",
  },
  {
    exportName: "drizzleAdapter",
    kind: "non-callable",
    moduleId: "better-auth/adapters/drizzle",
  },
  { exportName: "bearer", kind: "missing", moduleId: "better-auth/plugins/bearer" },
  {
    exportName: "bearer",
    kind: "non-callable",
    moduleId: "better-auth/plugins/bearer",
  },
] satisfies InvalidExportCase[];

it.effect("configures Better Auth with Nama's private runtime boundary", () =>
  Effect.gen(function* betterAuthConfigurationTest() {
    const fakes = makeRuntimeFakes();
    const secret = yield* Effect.promise(() => expectedSecret(MASTER_KEY));

    yield* makeBetterAuthAdapter(makeInput(fakes.loadModule));

    expectModuleLoading(fakes);
    expectDrizzleAdapterConfiguration(fakes);
    expectRuntimeConfiguration(fakes, secret);
  }),
);

for (const { exportName, kind, moduleId } of invalidExportCases) {
  it.effect(`normalizes a ${kind} ${moduleId} ${exportName} export`, () =>
    Effect.gen(function* invalidExportTest() {
      const fakes = makeRuntimeFakes();
      const privateError = makePrivateError();
      const runtimeModule = requireRuntimeModule(fakes, moduleId);
      runtimeModule[PRIVATE_PROPERTY] = privateError;
      if (kind === "missing") {
        delete runtimeModule[exportName];
      } else {
        runtimeModule[exportName] = privateError;
      }

      const failure = yield* makeBetterAuthAdapter(makeInput(fakes.loadModule)).pipe(Effect.flip);

      expectSafeConstructionFailure(failure, privateError);
    }),
  );
}

it.effect("normalizes a private module-loader failure without retaining its cause", () =>
  Effect.gen(function* loaderFailureTest() {
    const privateError = makePrivateError();
    const failure = yield* makeBetterAuthAdapter(
      makeInput(() => {
        throw privateError;
      }),
    ).pipe(Effect.flip);

    expectSafeConstructionFailure(failure, privateError);
  }),
);

it.effect("normalizes a Better Auth configuration failure without retaining its cause", () =>
  Effect.gen(function* configurationFailureTest() {
    const fakes = makeRuntimeFakes();
    const privateError = makePrivateError();
    const betterAuthModule = requireRuntimeModule(fakes, "better-auth");
    betterAuthModule["betterAuth"] = () => {
      throw privateError;
    };

    const failure = yield* makeBetterAuthAdapter(makeInput(fakes.loadModule)).pipe(Effect.flip);

    expectSafeConstructionFailure(failure, privateError);
  }),
);
