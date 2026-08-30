const MAXIMUM_MUTATION_BODY_BYTES = 65_536;
const INVALID_MUTATION_BODY = Symbol("invalid mutation body");
const NO_MUTATION_BODY = Symbol("no mutation body");

const serializedMutationBody = (body: Readonly<Record<string, unknown>> | undefined) => {
  if (body === undefined) {
    return NO_MUTATION_BODY;
  }
  try {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_MUTATION_BODY_BYTES) {
      return INVALID_MUTATION_BODY;
    }
    return serialized;
  } catch {
    return INVALID_MUTATION_BODY;
  }
};

export { INVALID_MUTATION_BODY, NO_MUTATION_BODY, serializedMutationBody };
