import { MIMEType } from "node:util";

const MAXIMUM_MIME_TYPE_LENGTH = 256;
const EMPTY_LENGTH = 0;
const ABSENT_MIME_TYPE = void Number.NaN;

const normalizedImageMimeType = (value: string | null): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === EMPTY_LENGTH ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_MIME_TYPE_LENGTH
  ) {
    return ABSENT_MIME_TYPE;
  }
  try {
    const mimeType = new MIMEType(value);
    if (mimeType.type !== "image") {
      return ABSENT_MIME_TYPE;
    }
    return mimeType.essence;
  } catch {
    return ABSENT_MIME_TYPE;
  }
};

export { normalizedImageMimeType };
