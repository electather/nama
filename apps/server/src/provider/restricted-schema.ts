// oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary, eslint/prefer-destructuring, eslint/sort-keys -- The restricted profile keeps every accepted keyword, type-specific constraint, and monotonic compatibility rule explicit.
import type { JsonObject, JsonValue } from "../database/provider-schema.ts";

const SUPPORTED_SCHEMA_PROFILE_VERSION = 1;
const SUPPORTED_CONTRACT_MAJOR = 1;
const MAXIMUM_CAPABILITIES = 32;
const MAXIMUM_PROPERTIES = 100;
const MAXIMUM_SCHEMA_COLLECTION_ITEMS = 100;
const MAXIMUM_PROVIDER_IDENTIFIER_LENGTH = 256;
const MAXIMUM_CONFIGURATION_BYTES = 65_536;
const MAXIMUM_CONFIGURATION_SCHEMA_BYTES = 65_536;
const MAXIMUM_DESCRIPTION_LENGTH = 1024;
const SAFE_PROPERTY_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const FIRST_KNOWN_CAPABILITY = 1;
const LAST_KNOWN_CAPABILITY = 9;
const ROOT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  additionalProperties: true,
  description: true,
  properties: true,
  required: true,
  title: true,
  type: true,
});
const PROPERTY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  default: true,
  description: true,
  enum: true,
  examples: true,
  format: true,
  items: true,
  maximum: true,
  maxItems: true,
  maxLength: true,
  minimum: true,
  minItems: true,
  minLength: true,
  title: true,
  type: true,
  uniqueItems: true,
  writeOnly: true,
  "x-nama-order": true,
});
const ITEM_KEYS: Readonly<Record<string, true>> = Object.freeze({ enum: true, type: true });
const STRING_FORMATS: Readonly<Record<string, true>> = Object.freeze({
  hostname: true,
  password: true,
  uri: true,
});
const PROPERTY_TYPES: Readonly<Record<string, true>> = Object.freeze({
  array: true,
  boolean: true,
  integer: true,
  number: true,
  string: true,
});
const BOOLEAN_PROPERTY_FORBIDDEN_KEYS: Readonly<Record<string, true>> = Object.freeze({
  format: true,
  items: true,
  maximum: true,
  maxItems: true,
  maxLength: true,
  minimum: true,
  minItems: true,
  minLength: true,
  uniqueItems: true,
});

interface DiscoveredPluginInfo {
  readonly buildVersion: string;
  readonly capabilities: readonly number[];
  readonly configurationSchema?: unknown;
  readonly contractMajor: number;
  readonly description: string;
  readonly displayName: string;
  readonly providerTypeId: string;
  readonly schemaProfileVersion: number;
  readonly schemaRevision: string;
}

interface NormalizedProviderInstallation {
  readonly capabilities: readonly number[];
  readonly configurationSchema: JsonObject;
  readonly contractMajor: number;
  readonly description: string;
  readonly displayName: string;
  readonly pluginBuildVersion: string;
  readonly providerTypeId: string;
  readonly schemaProfileVersion: number;
  readonly schemaRevision: string;
}

type SchemaObject = Readonly<Record<string, unknown>>;

// fallow-ignore-next-line complexity -- The schema trust boundary validates plain data properties before any keyword inspection.
const schemaObject = (value: unknown): SchemaObject | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    return undefined;
  }
  const object: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    object[key] = descriptor.value;
  }
  return object;
};

const hasOnlyKeys = (value: SchemaObject, allowed: Readonly<Record<string, true>>): boolean =>
  Object.keys(value).every((key) => allowed[key] === true);

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const validNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const validFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const denseArray = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    !keys.every((key, index) => key === String(index))
  ) {
    return undefined;
  }
  const items: unknown[] = [];
  for (const item of value) {
    items.push(item);
  }
  return items;
};

const scalarMatchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "boolean": {
      return typeof value === "boolean";
    }
    case "integer": {
      return typeof value === "number" && Number.isSafeInteger(value);
    }
    case "number": {
      return validFiniteNumber(value);
    }
    case "string": {
      return typeof value === "string";
    }
    default: {
      return false;
    }
  }
};

const validEnum = (value: unknown, type: string): boolean => {
  const values = denseArray(value);
  if (
    values === undefined ||
    values.length === 0 ||
    values.length > MAXIMUM_SCHEMA_COLLECTION_ITEMS
  ) {
    return false;
  }
  const uniqueValues = new Set<unknown>();
  for (const candidate of values) {
    if (!scalarMatchesType(candidate, type) || uniqueValues.has(candidate)) {
      return false;
    }
    uniqueValues.add(candidate);
  }
  return true;
};

const validExamples = (value: unknown, type: string, items: SchemaObject | undefined): boolean => {
  const examples = denseArray(value);
  if (examples === undefined || examples.length > MAXIMUM_SCHEMA_COLLECTION_ITEMS) {
    return false;
  }
  if (type !== "array") {
    return examples.every((example) => scalarMatchesType(example, type));
  }
  return examples.every((example) => {
    const values = denseArray(example);
    return (
      values !== undefined &&
      values.length <= MAXIMUM_SCHEMA_COLLECTION_ITEMS &&
      values.every((item) => typeof item === "string") &&
      items !== undefined
    );
  });
};

const validArrayItems = (value: unknown): value is SchemaObject => {
  const items = schemaObject(value);
  if (items === undefined || !hasOnlyKeys(items, ITEM_KEYS) || items["type"] !== "string") {
    return false;
  }
  return items["enum"] === undefined || validEnum(items["enum"], "string");
};

const validCommonAnnotations = (schema: SchemaObject): boolean =>
  optionalString(schema["title"]) &&
  optionalString(schema["description"]) &&
  (schema["x-nama-order"] === undefined ||
    (typeof schema["x-nama-order"] === "number" && Number.isSafeInteger(schema["x-nama-order"]))) &&
  (schema["writeOnly"] === undefined || typeof schema["writeOnly"] === "boolean");

// fallow-ignore-next-line complexity -- String constraints are accepted only as one complete type-specific profile.
const validStringProperty = (schema: SchemaObject): boolean => {
  const minimum = schema["minLength"];
  const maximum = schema["maxLength"];
  return (
    (minimum === undefined || validNonnegativeInteger(minimum)) &&
    (maximum === undefined || validNonnegativeInteger(maximum)) &&
    !(typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) &&
    (schema["format"] === undefined ||
      (typeof schema["format"] === "string" && STRING_FORMATS[schema["format"]] === true)) &&
    schema["items"] === undefined &&
    schema["minItems"] === undefined &&
    schema["maxItems"] === undefined &&
    schema["uniqueItems"] === undefined
  );
};

// fallow-ignore-next-line complexity -- Numeric constraints are accepted only as one complete type-specific profile.
const validNumericProperty = (schema: SchemaObject, integer: boolean): boolean => {
  const minimum = schema["minimum"];
  const maximum = schema["maximum"];
  const validBound = integer ? validSafeInteger : validFiniteNumber;
  return (
    (minimum === undefined || validBound(minimum)) &&
    (maximum === undefined || validBound(maximum)) &&
    !(typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) &&
    schema["format"] === undefined &&
    schema["minLength"] === undefined &&
    schema["maxLength"] === undefined &&
    schema["items"] === undefined &&
    schema["minItems"] === undefined &&
    schema["maxItems"] === undefined &&
    schema["uniqueItems"] === undefined
  );
};

// fallow-ignore-next-line complexity -- Array constraints are accepted only as one complete type-specific profile.
const validArrayProperty = (schema: SchemaObject): boolean => {
  const minimum = schema["minItems"];
  const maximum = schema["maxItems"];
  return (
    validArrayItems(schema["items"]) &&
    (minimum === undefined || validNonnegativeInteger(minimum)) &&
    (maximum === undefined || validNonnegativeInteger(maximum)) &&
    !(typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) &&
    (schema["uniqueItems"] === undefined || typeof schema["uniqueItems"] === "boolean") &&
    schema["format"] === undefined &&
    schema["minLength"] === undefined &&
    schema["maxLength"] === undefined &&
    schema["minimum"] === undefined &&
    schema["maximum"] === undefined &&
    schema["enum"] === undefined
  );
};

const validDefault = (
  schema: SchemaObject,
  type: string,
  items: SchemaObject | undefined,
): boolean => {
  const value = schema["default"];
  if (value === undefined) {
    return true;
  }
  if (schema["writeOnly"] === true) {
    return false;
  }
  if (type !== "array") {
    return scalarMatchesType(value, type);
  }
  const values = denseArray(value);
  return (
    values !== undefined && items !== undefined && values.every((item) => typeof item === "string")
  );
};

const propertySchema = (value: unknown): SchemaObject | undefined => {
  const schema = schemaObject(value);
  if (schema === undefined || !hasOnlyKeys(schema, PROPERTY_KEYS)) {
    return undefined;
  }
  return schema;
};

const propertyType = (schema: SchemaObject): string | undefined => {
  const type = schema["type"];
  if (
    typeof type !== "string" ||
    PROPERTY_TYPES[type] !== true ||
    !validCommonAnnotations(schema) ||
    (schema["writeOnly"] === true && type !== "string")
  ) {
    return undefined;
  }
  return type;
};

const propertyItems = (schema: SchemaObject, type: string): SchemaObject | undefined =>
  type === "array" && validArrayItems(schema["items"]) ? schemaObject(schema["items"]) : undefined;

const validPropertyDeclarations = (
  schema: SchemaObject,
  type: string,
  items: SchemaObject | undefined,
): boolean =>
  validDefault(schema, type, items) &&
  (schema["examples"] === undefined || validExamples(schema["examples"], type, items)) &&
  (schema["enum"] === undefined || validEnum(schema["enum"], type));

const validBooleanProperty = (schema: SchemaObject): boolean => {
  for (const key in BOOLEAN_PROPERTY_FORBIDDEN_KEYS) {
    if (schema[key] !== undefined) {
      return false;
    }
  }
  return true;
};

const validProperty = (value: unknown): boolean => {
  const schema = propertySchema(value);
  if (schema === undefined) {
    return false;
  }
  const type = propertyType(schema);
  if (type === undefined) {
    return false;
  }
  const items = propertyItems(schema, type);
  if (!validPropertyDeclarations(schema, type, items)) {
    return false;
  }
  switch (type) {
    case "array": {
      return validArrayProperty(schema);
    }
    case "boolean": {
      return validBooleanProperty(schema);
    }
    case "integer": {
      return validNumericProperty(schema, true);
    }
    case "number": {
      return validNumericProperty(schema, false);
    }
    case "string": {
      return validStringProperty(schema);
    }
    default: {
      return false;
    }
  }
};

const schemaWithinByteLimit = (value: unknown): boolean => {
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      Buffer.byteLength(encoded, "utf8") <= MAXIMUM_CONFIGURATION_SCHEMA_BYTES
    );
  } catch {
    return false;
  }
};

const restrictedRoot = (value: unknown): SchemaObject | undefined => {
  if (!schemaWithinByteLimit(value)) {
    return undefined;
  }
  const root = schemaObject(value);
  if (
    root === undefined ||
    !hasOnlyKeys(root, ROOT_KEYS) ||
    root["type"] !== "object" ||
    root["additionalProperties"] !== false ||
    !optionalString(root["title"]) ||
    !optionalString(root["description"])
  ) {
    return undefined;
  }
  return root;
};

const restrictedProperties = (value: unknown): SchemaObject | undefined => {
  const properties = schemaObject(value);
  if (properties === undefined || Object.keys(properties).length > MAXIMUM_PROPERTIES) {
    return undefined;
  }
  for (const [name, property] of Object.entries(properties)) {
    if (
      !SAFE_PROPERTY_NAME.test(name) ||
      Buffer.byteLength(name, "utf8") > MAXIMUM_PROVIDER_IDENTIFIER_LENGTH ||
      !validProperty(property)
    ) {
      return undefined;
    }
  }
  return properties;
};

const validRequiredProperties = (value: unknown, properties: SchemaObject): boolean => {
  if (value === undefined) {
    return true;
  }
  const required = denseArray(value);
  if (required === undefined || required.length > MAXIMUM_SCHEMA_COLLECTION_ITEMS) {
    return false;
  }
  const uniqueRequired = new Set<string>();
  // fallow-ignore-next-line code-duplication -- Required keys and enum values share bounded duplicate rejection but enforce different element contracts.
  for (const name of required) {
    if (typeof name !== "string" || !Object.hasOwn(properties, name) || uniqueRequired.has(name)) {
      return false;
    }
    uniqueRequired.add(name);
  }
  return true;
};

const validRestrictedSchema = (value: unknown): value is JsonObject => {
  const root = restrictedRoot(value);
  if (root === undefined) {
    return false;
  }
  const properties = restrictedProperties(root["properties"]);
  return properties !== undefined && validRequiredProperties(root["required"], properties);
};

const validBoundedString = (value: string, maximumLength: number, required: boolean): boolean =>
  (!required || value.length > 0) && value.length <= maximumLength;

const normalizeDiscoveredPluginInfo = (
  info: DiscoveredPluginInfo,
  expectedProviderType: string,
): NormalizedProviderInstallation | undefined => {
  if (
    info.providerTypeId !== expectedProviderType ||
    !validBoundedString(info.providerTypeId, MAXIMUM_PROVIDER_IDENTIFIER_LENGTH, true) ||
    !validBoundedString(info.displayName, MAXIMUM_PROVIDER_IDENTIFIER_LENGTH, true) ||
    !validBoundedString(info.description, MAXIMUM_DESCRIPTION_LENGTH, false) ||
    !validBoundedString(info.buildVersion, MAXIMUM_PROVIDER_IDENTIFIER_LENGTH, true) ||
    !validBoundedString(info.schemaRevision, MAXIMUM_PROVIDER_IDENTIFIER_LENGTH, true) ||
    info.contractMajor !== SUPPORTED_CONTRACT_MAJOR ||
    info.schemaProfileVersion !== SUPPORTED_SCHEMA_PROFILE_VERSION ||
    !validRestrictedSchema(info.configurationSchema)
  ) {
    return undefined;
  }
  const capabilities = denseArray(info.capabilities);
  if (
    capabilities === undefined ||
    capabilities.length > MAXIMUM_CAPABILITIES ||
    capabilities.some(
      (capability, index) =>
        typeof capability !== "number" ||
        !Number.isSafeInteger(capability) ||
        capability <= 0 ||
        capabilities.indexOf(capability) !== index,
    )
  ) {
    return undefined;
  }
  const knownCapabilities: number[] = [];
  for (const capability of capabilities) {
    if (
      typeof capability === "number" &&
      capability >= FIRST_KNOWN_CAPABILITY &&
      capability <= LAST_KNOWN_CAPABILITY
    ) {
      knownCapabilities.push(capability);
    }
  }
  return Object.freeze({
    capabilities: Object.freeze(knownCapabilities),
    configurationSchema: structuredClone(info.configurationSchema),
    contractMajor: info.contractMajor,
    description: info.description,
    displayName: info.displayName,
    pluginBuildVersion: info.buildVersion,
    providerTypeId: info.providerTypeId,
    schemaProfileVersion: info.schemaProfileVersion,
    schemaRevision: info.schemaRevision,
  });
};

const propertyMap = (installation: NormalizedProviderInstallation): SchemaObject =>
  schemaObject(installation.configurationSchema["properties"]) ?? {};

const requiredSchemaProperties = (schema: JsonObject): ReadonlySet<string> => {
  const required = denseArray(schema["required"]) ?? [];
  return new Set(required.filter((value): value is string => typeof value === "string"));
};

const enumContainsPriorValues = (previous: unknown, next: unknown): boolean => {
  if (previous === undefined) {
    return next === undefined;
  }
  if (next === undefined) {
    return true;
  }
  const previousValues = denseArray(previous);
  const nextValues = denseArray(next);
  return (
    previousValues !== undefined &&
    nextValues !== undefined &&
    previousValues.every((value) => nextValues.includes(value))
  );
};

const minimumConstraintCompatible = (previous: unknown, next: unknown): boolean => {
  if (previous === undefined) {
    return next === undefined;
  }
  return (
    next === undefined ||
    (typeof previous === "number" && typeof next === "number" && next <= previous)
  );
};

const maximumConstraintCompatible = (previous: unknown, next: unknown): boolean => {
  if (previous === undefined) {
    return next === undefined;
  }
  return (
    next === undefined ||
    (typeof previous === "number" && typeof next === "number" && next >= previous)
  );
};

// fallow-ignore-next-line complexity -- Compatibility compares every monotonic property classification and constraint in one decision.
const propertyCompatible = (previousValue: unknown, nextValue: unknown): boolean => {
  const previous = schemaObject(previousValue);
  const next = schemaObject(nextValue);
  if (previous === undefined || next === undefined) {
    return false;
  }
  if (
    previous["type"] !== next["type"] ||
    previous["format"] !== next["format"] ||
    (previous["writeOnly"] === true) !== (next["writeOnly"] === true) ||
    !enumContainsPriorValues(previous["enum"], next["enum"]) ||
    !minimumConstraintCompatible(previous["minLength"], next["minLength"]) ||
    !minimumConstraintCompatible(previous["minimum"], next["minimum"]) ||
    !minimumConstraintCompatible(previous["minItems"], next["minItems"]) ||
    !maximumConstraintCompatible(previous["maxLength"], next["maxLength"]) ||
    !maximumConstraintCompatible(previous["maximum"], next["maximum"]) ||
    !maximumConstraintCompatible(previous["maxItems"], next["maxItems"]) ||
    (next["uniqueItems"] === true && previous["uniqueItems"] !== true)
  ) {
    return false;
  }
  if (previous["type"] !== "array") {
    return true;
  }
  const previousItems = schemaObject(previous["items"]);
  const nextItems = schemaObject(next["items"]);
  return (
    previousItems !== undefined &&
    nextItems !== undefined &&
    enumContainsPriorValues(previousItems["enum"], nextItems["enum"])
  );
};

const isInstallationSchemaCompatible = (
  previous: NormalizedProviderInstallation,
  next: NormalizedProviderInstallation,
  migratedRequiredProperties: readonly string[],
): boolean => {
  if (
    previous.providerTypeId !== next.providerTypeId ||
    previous.schemaProfileVersion !== next.schemaProfileVersion
  ) {
    return false;
  }
  const previousProperties = propertyMap(previous);
  const nextProperties = propertyMap(next);
  for (const [name, previousProperty] of Object.entries(previousProperties)) {
    if (
      !Object.hasOwn(nextProperties, name) ||
      !propertyCompatible(previousProperty, nextProperties[name])
    ) {
      return false;
    }
  }
  const migratedRequired = new Set(migratedRequiredProperties);
  if (
    migratedRequired.size !== migratedRequiredProperties.length ||
    migratedRequiredProperties.some(
      (property) => !SAFE_PROPERTY_NAME.test(property) || !Object.hasOwn(nextProperties, property),
    )
  ) {
    return false;
  }
  const previousRequired = requiredSchemaProperties(previous.configurationSchema);
  for (const property of requiredSchemaProperties(next.configurationSchema)) {
    if (!previousRequired.has(property) && !migratedRequired.has(property)) {
      return false;
    }
  }
  return true;
};

const numericMinimumAllows = (value: number, minimum: unknown): boolean =>
  typeof minimum !== "number" || value >= minimum;

const numericMaximumAllows = (value: number, maximum: unknown): boolean =>
  typeof maximum !== "number" || value <= maximum;

const enumAllows = (value: JsonValue, enumeration: unknown): boolean => {
  if (enumeration === undefined) {
    return true;
  }
  const values = denseArray(enumeration);
  return values !== undefined && values.includes(value);
};

// fallow-ignore-next-line complexity -- Format validation keeps URI and hostname parsing policy at the configuration trust boundary.
const stringFormatAllows = (value: string, format: unknown): boolean => {
  if (format === undefined || format === "password") {
    return true;
  }
  if (format === "uri") {
    return URL.canParse(value);
  }
  if (format !== "hostname" || !URL.canParse(`http://${value}`)) {
    return false;
  }
  const parsed = new URL(`http://${value}`);
  return (
    parsed.hostname.length > 0 &&
    parsed.port.length === 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.pathname === "/"
  );
};

const stringPropertyAllows = (value: JsonValue, property: SchemaObject): boolean => {
  if (typeof value !== "string" || !enumAllows(value, property["enum"])) {
    return false;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  return (
    numericMinimumAllows(byteLength, property["minLength"]) &&
    numericMaximumAllows(byteLength, property["maxLength"]) &&
    stringFormatAllows(value, property["format"])
  );
};

const numberPropertyAllows = (
  value: JsonValue,
  property: SchemaObject,
  integer: boolean,
): boolean =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  (!integer || Number.isSafeInteger(value)) &&
  enumAllows(value, property["enum"]) &&
  numericMinimumAllows(value, property["minimum"]) &&
  numericMaximumAllows(value, property["maximum"]);

// fallow-ignore-next-line complexity -- Array validation applies item type, enum, cardinality, and uniqueness as one schema decision.
const arrayPropertyAllows = (value: JsonValue, property: SchemaObject): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }
  const values = denseArray(value);
  const items = schemaObject(property["items"]);
  if (
    values === undefined ||
    items === undefined ||
    !numericMinimumAllows(values.length, property["minItems"]) ||
    !numericMaximumAllows(values.length, property["maxItems"])
  ) {
    return false;
  }
  const unique = new Set<string>();
  for (const item of values) {
    if (
      typeof item !== "string" ||
      !enumAllows(item, items["enum"]) ||
      (property["uniqueItems"] === true && unique.has(item))
    ) {
      return false;
    }
    unique.add(item);
  }
  return true;
};

const propertyValueAllowed = (value: JsonValue, propertyValue: unknown): boolean => {
  const property = schemaObject(propertyValue);
  if (property === undefined) {
    return false;
  }
  switch (property["type"]) {
    case "array": {
      return arrayPropertyAllows(value, property);
    }
    case "boolean": {
      return typeof value === "boolean" && enumAllows(value, property["enum"]);
    }
    case "integer": {
      return numberPropertyAllows(value, property, true);
    }
    case "number": {
      return numberPropertyAllows(value, property, false);
    }
    case "string": {
      return stringPropertyAllows(value, property);
    }
    default: {
      return false;
    }
  }
};

const configurationMatchesRestrictedSchema = (
  schema: JsonObject,
  configuration: JsonObject,
): boolean => {
  if (
    !validRestrictedSchema(schema) ||
    Buffer.byteLength(JSON.stringify(configuration), "utf8") > MAXIMUM_CONFIGURATION_BYTES
  ) {
    return false;
  }
  const properties = schemaObject(schema["properties"]);
  if (properties === undefined) {
    return false;
  }
  for (const required of requiredSchemaProperties(schema)) {
    if (!Object.hasOwn(configuration, required)) {
      return false;
    }
  }
  for (const [key, value] of Object.entries(configuration)) {
    if (!Object.hasOwn(properties, key) || !propertyValueAllowed(value, properties[key])) {
      return false;
    }
  }
  return true;
};

export {
  configurationMatchesRestrictedSchema,
  isInstallationSchemaCompatible,
  normalizeDiscoveredPluginInfo,
};
export type { DiscoveredPluginInfo, NormalizedProviderInstallation };
