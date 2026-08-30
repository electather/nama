const ZERO = 0;

const normalizedLocatorOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > ZERO ||
      url.password.length > ZERO
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
};

export { normalizedLocatorOrigin };
