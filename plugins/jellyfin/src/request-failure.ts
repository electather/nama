import { Code, ConnectError } from "@connectrpc/connect";

const HTTP_REDIRECT_MINIMUM = 300;
const HTTP_REDIRECT_MAXIMUM = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MINIMUM = 500;

type JellyfinRequestAuthentication = "api_key" | "none";
type JellyfinFailureKind =
  | "authentication_failed"
  | "forbidden"
  | "incompatible"
  | "not_found"
  | "unreachable";
type JellyfinFailureResponse = Readonly<{ kind: JellyfinFailureKind }>;
type JellyfinFailureCategory = "forbidden" | "missing" | "permanent" | "retryable";

const credentialFailureKind = (
  status: number,
  authentication: JellyfinRequestAuthentication,
): JellyfinFailureKind | undefined => {
  if (status !== HTTP_UNAUTHORIZED && status !== HTTP_FORBIDDEN && status !== HTTP_NOT_FOUND) {
    return undefined;
  }
  if (authentication !== "api_key") {
    return "incompatible";
  }
  if (status === HTTP_UNAUTHORIZED) {
    return "authentication_failed";
  }
  if (status === HTTP_FORBIDDEN) {
    return "forbidden";
  }
  return "not_found";
};

const jellyfinFailureKind = (response: Response): JellyfinFailureKind | undefined => {
  if (response.status >= HTTP_REDIRECT_MINIMUM && response.status < HTTP_REDIRECT_MAXIMUM) {
    return "incompatible";
  }
  if (response.ok) {
    return undefined;
  }
  if (response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_MINIMUM) {
    return "unreachable";
  }
  return "incompatible";
};

const jellyfinFailureCategory = (kind: JellyfinFailureKind): JellyfinFailureCategory => {
  if (kind === "authentication_failed" || kind === "forbidden") {
    return "forbidden";
  }
  if (kind === "not_found") {
    return "missing";
  }
  if (kind === "unreachable") {
    return "retryable";
  }
  return "permanent";
};

const cancelResponseBody = async (response: Response): Promise<boolean> => {
  if (response.body === null) {
    return true;
  }
  try {
    await response.body.cancel();
    return true;
  } catch {
    return false;
  }
};

const readJellyfinFailureResponse = async (
  response: Response,
  authentication: JellyfinRequestAuthentication,
  signal: AbortSignal,
): Promise<JellyfinFailureResponse | undefined> => {
  const kind =
    credentialFailureKind(response.status, authentication) ?? jellyfinFailureKind(response);
  if (kind === undefined) {
    return undefined;
  }
  const cancelled = await cancelResponseBody(response);
  if (signal.aborted) {
    throw new ConnectError("request cancelled", Code.Canceled);
  }
  if (!cancelled) {
    return { kind: "unreachable" };
  }
  return { kind };
};

export { jellyfinFailureCategory, readJellyfinFailureResponse };
export type {
  JellyfinFailureCategory,
  JellyfinFailureKind,
  JellyfinFailureResponse,
  JellyfinRequestAuthentication,
};
