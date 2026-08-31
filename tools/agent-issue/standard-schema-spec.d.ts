// Sandcastle 0.12.0 publishes this type import without declaring the type-only package.
declare module "@standard-schema/spec" {
  export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (
        value: unknown,
      ) =>
        | { readonly value: Output; readonly issues?: undefined }
        | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        | Promise<
            | { readonly value: Output; readonly issues?: undefined }
            | { readonly issues: ReadonlyArray<{ readonly message: string }> }
          >;
      readonly types?: {
        readonly input: Input;
        readonly output: Output;
      };
    };
  }

  export namespace StandardSchemaV1 {
    export type InferOutput<Schema> =
      Schema extends StandardSchemaV1<unknown, infer Output> ? Output : never;
  }
}
