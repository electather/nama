const expectJellyfinResponseStatus = (response: Response, expectedStatus: number): void => {
  if (response.status !== expectedStatus) {
    throw new Error(`Jellyfin fixture request failed with status ${String(response.status)}`);
  }
};

const jellyfinJsonObjectResponse = async (
  response: Response,
  expectedStatus: number,
): Promise<Record<string, unknown>> => {
  expectJellyfinResponseStatus(response, expectedStatus);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a Jellyfin JSON object");
  }
  return Object.fromEntries(Object.entries(value));
};

const jellyfinJsonObjects = (
  value: unknown,
  errorMessage: string,
): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(errorMessage);
  }
  const entries: readonly unknown[] = value;
  return entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(errorMessage);
    }
    return Object.fromEntries(Object.entries(entry));
  });
};

const jellyfinJsonObjectArrayResponse = async (
  response: Response,
  expectedStatus: number,
): Promise<readonly Record<string, unknown>[]> => {
  expectJellyfinResponseStatus(response, expectedStatus);
  const value: unknown = await response.json();
  return jellyfinJsonObjects(value, "expected a Jellyfin JSON object array");
};

export {
  expectJellyfinResponseStatus,
  jellyfinJsonObjectArrayResponse,
  jellyfinJsonObjects,
  jellyfinJsonObjectResponse,
};
