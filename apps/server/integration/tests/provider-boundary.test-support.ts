const PUBLIC_REFERENCE_KEY = /(?:id|index|reference)$/iu;

const collectPrimitiveReference = (
  value: unknown,
  references: Set<string>,
  key: string,
): boolean => {
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }
  if (PUBLIC_REFERENCE_KEY.test(key)) {
    references.add(String(value));
  }
  return true;
};

const collectPublicReferenceValues = (value: unknown, references: Set<string>, key = ""): void => {
  if (collectPrimitiveReference(value, references, key)) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPublicReferenceValues(item, references, key);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [property, nested] of Object.entries(value)) {
    collectPublicReferenceValues(nested, references, property);
  }
};

export { collectPublicReferenceValues };
