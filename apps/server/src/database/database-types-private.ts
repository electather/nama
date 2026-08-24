import { customType } from "drizzle-orm/pg-core";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = Readonly<Record<string, JsonValue>>;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export { bytea };
export type { JsonObject, JsonPrimitive, JsonValue };
