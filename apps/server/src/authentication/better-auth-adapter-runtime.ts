import { Effect } from "effect";

type RuntimeModuleId =
  | "better-auth"
  | "better-auth/adapters/drizzle"
  | "better-auth/plugins/bearer";
type RuntimeModuleLoader = (moduleId: RuntimeModuleId) => unknown;
type RuntimeFunction = (...arguments_: readonly unknown[]) => unknown;

interface RuntimeMethod {
  readonly api: object;
  readonly call: RuntimeFunction;
}

interface RuntimeCallOptions<Failure, Defect> {
  readonly defect: Defect;
  readonly input: unknown;
  readonly methodName: string;
  readonly onRejection: (rejection: unknown) => Failure;
  readonly runtime: unknown;
}

const isObjectValue = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRuntimeFunction = (value: unknown): value is RuntimeFunction => typeof value === "function";

const readProperty = (value: object, name: string): unknown => Reflect.get(value, name);

const readRuntimeMethod = (runtime: unknown, methodName: string): RuntimeMethod | undefined => {
  if (!isObjectValue(runtime)) {
    return undefined;
  }
  const api = readProperty(runtime, "api");
  if (!isObjectValue(api)) {
    return undefined;
  }
  const call = readProperty(api, methodName);
  if (!isRuntimeFunction(call)) {
    return undefined;
  }
  return { api, call };
};

const readRuntimeModule = (runtimeModule: unknown): object => {
  if (!isObjectValue(runtimeModule)) {
    throw new TypeError("Better Auth module must be an object");
  }
  return runtimeModule;
};

const readRuntimeFunction = (runtimeModule: object, exportName: string): RuntimeFunction => {
  const candidate = readProperty(runtimeModule, exportName);
  if (!isRuntimeFunction(candidate)) {
    throw new TypeError("Better Auth export must be callable");
  }
  return candidate;
};

const invokeRuntimeFunction = (
  runtimeFunction: RuntimeFunction,
  parameters: readonly unknown[],
): unknown => {
  const result: unknown = Reflect.apply(runtimeFunction, undefined, parameters);
  return result;
};

const callRuntime = <Failure, Defect>({
  defect,
  input,
  methodName,
  onRejection,
  runtime,
}: RuntimeCallOptions<Failure, Defect>): Effect.Effect<unknown, Failure | Defect> =>
  Effect.try<RuntimeMethod | undefined, Defect>({
    catch: () => defect,
    try: () => readRuntimeMethod(runtime, methodName),
  }).pipe(
    Effect.flatMap((runtimeMethod): Effect.Effect<unknown, Failure | Defect> => {
      if (runtimeMethod === undefined) {
        return Effect.fail(defect);
      }
      return Effect.tryPromise<unknown, Failure>({
        catch: onRejection,
        try: () => Promise.resolve(Reflect.apply(runtimeMethod.call, runtimeMethod.api, [input])),
      });
    }),
  );

export {
  callRuntime,
  invokeRuntimeFunction,
  isObjectValue,
  readProperty,
  readRuntimeFunction,
  readRuntimeModule,
};
export type { RuntimeCallOptions, RuntimeFunction, RuntimeModuleId, RuntimeModuleLoader };
