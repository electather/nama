import type { ServerResponse } from "node:http";

const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const EXTENSION_FAULT_HEADER = "x-nama-test-progress-fault";
type ExtensionProgressFault = "persistence" | "readback";
const INCREMENT = 1;
interface ProgressFaultRequest {
  readonly isProgress: boolean;
  readonly method: string;
  readonly requestUrl: string;
  readonly response: ServerResponse;
}

interface ProgressResponseLossRequest {
  readonly isProgress: boolean;
  readonly response: ServerResponse;
  readonly upstream: Response;
}
interface ProgressFaultState {
  committedLostResponses: number;
  extensionFault: ExtensionProgressFault | undefined;
  failNextReadbackResponse: boolean;
  failureSecret: string | undefined;
  loseNextResponse: boolean;
  requests: number;
}
interface ProgressFaultController {
  readonly applyFailure: (request: ProgressFaultRequest) => boolean;
  readonly applyResponseLoss: (
    isProgress: boolean,
    response: ServerResponse,
    upstream: Response,
  ) => boolean;
  readonly committedLostResponses: () => number;
  readonly failNextExtensionPersistence: () => void;
  readonly failNextExtensionReadback: () => void;
  readonly failNextReadbackResponse: () => void;
  readonly failNextResponse: (secret: string) => void;
  readonly loseNextResponse: () => void;
  readonly observe: (method: string, requestUrl: string) => boolean;
  readonly requests: () => number;
  readonly upstreamHeaders: (isProgress: boolean, headers: Headers) => Headers;
}
const applyReadbackFailure = (
  state: ProgressFaultState,
  { method, requestUrl, response }: ProgressFaultRequest,
): boolean => {
  if (!state.failNextReadbackResponse || method !== "GET" || !requestUrl.startsWith("/Items/")) {
    return false;
  }
  state.failNextReadbackResponse = false;
  response.statusCode = HTTP_SERVICE_UNAVAILABLE;
  response.end();
  return true;
};

const applyMutationFailure = (
  state: ProgressFaultState,
  { isProgress, response }: ProgressFaultRequest,
): boolean => {
  if (!isProgress || state.failureSecret === undefined) {
    return false;
  }
  const secret = state.failureSecret;
  state.failureSecret = undefined;
  response.statusCode = HTTP_INTERNAL_SERVER_ERROR;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: secret }));
  return true;
};

const applyFailure = (state: ProgressFaultState, request: ProgressFaultRequest): boolean => {
  if (applyReadbackFailure(state, request)) {
    return true;
  }
  return applyMutationFailure(state, request);
};

const applyResponseLoss = (
  state: ProgressFaultState,
  { isProgress, response, upstream }: ProgressResponseLossRequest,
): boolean => {
  if (!isProgress || !state.loseNextResponse) {
    return false;
  }
  state.loseNextResponse = false;
  if (!upstream.ok) {
    throw new Error("Jellyfin rejected the progress selected for response loss");
  }
  state.committedLostResponses += INCREMENT;
  response.destroy();
  return true;
};

const observe = (state: ProgressFaultState, method: string, requestUrl: string): boolean => {
  const isProgress = method === "POST" && requestUrl === "/Nama/v1/progress";
  if (isProgress) {
    state.requests += INCREMENT;
  }
  return isProgress;
};
const upstreamHeaders = (
  state: ProgressFaultState,
  isProgress: boolean,
  headers: Headers,
): Headers => {
  if (!isProgress || state.extensionFault === undefined) {
    return headers;
  }
  headers.set(EXTENSION_FAULT_HEADER, state.extensionFault);
  state.extensionFault = undefined;
  return headers;
};

const createProgressFaultController = (): ProgressFaultController => {
  const state: ProgressFaultState = {
    committedLostResponses: 0,
    extensionFault: undefined,
    failNextReadbackResponse: false,
    failureSecret: undefined,
    loseNextResponse: false,
    requests: 0,
  };
  return {
    applyFailure: (request) => applyFailure(state, request),
    applyResponseLoss: (isProgress, response, upstream) =>
      applyResponseLoss(state, { isProgress, response, upstream }),
    committedLostResponses: () => state.committedLostResponses,
    failNextExtensionPersistence: () => {
      state.extensionFault = "persistence";
    },
    failNextExtensionReadback: () => {
      state.extensionFault = "readback";
    },
    failNextReadbackResponse: () => {
      state.failNextReadbackResponse = true;
    },
    failNextResponse: (secret) => {
      state.failureSecret = secret;
    },
    loseNextResponse: () => {
      state.loseNextResponse = true;
    },
    observe: (method, requestUrl) => observe(state, method, requestUrl),
    requests: () => state.requests,
    upstreamHeaders: (isProgress, headers) => upstreamHeaders(state, isProgress, headers),
  };
};

export { createProgressFaultController };
export type { ProgressFaultController, ProgressFaultRequest };
