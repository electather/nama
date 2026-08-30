import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";

import { Effect } from "effect";

import type { JellyfinFixture } from "./provider-durable-loop.test-support.ts";

const EPHEMERAL_PORT = 0;
const HTTP_BAD_GATEWAY = 502;
const PROXY_ORIGIN = "http://proxy.invalid";

type PlanResponseFault =
  | { readonly kind: "malformed"; readonly secret: string }
  | { readonly kind: "redirect" }
  | {
      readonly cancellationObserved: () => void;
      readonly kind: "stall";
      readonly requestStarted: () => void;
    };

interface FaultProxyState {
  committedLostReportResponses: number;
  loseNextReportResponse: boolean;
  planRequests: number;
  planResponseFault: PlanResponseFault | undefined;
  reportRequests: number;
}

interface RequestObservation {
  readonly isPlan: boolean;
  readonly isReport: boolean;
}

interface ProxyForwardInput {
  readonly jellyfin: JellyfinFixture;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly state: FaultProxyState;
}

interface ProxyRequestInput {
  readonly jellyfin: JellyfinFixture;
  readonly method: string;
  readonly request: IncomingMessage;
  readonly requestUrl: string;
}

interface ResponseFaultInput {
  readonly response: ServerResponse;
  readonly state: FaultProxyState;
  readonly upstream: Response;
}

interface ReportFaultInput extends ResponseFaultInput {
  readonly observation: RequestObservation;
}

const proxyHeaders = (incoming: IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (value !== undefined) {
      headers.set(name, value.join(", "));
    }
  }
  headers.delete("accept-encoding");
  headers.delete("content-length");
  headers.delete("host");
  return headers;
};

const proxyTarget = (requestUrl: string, baseUrl: string): URL => {
  const requested = new URL(requestUrl, PROXY_ORIGIN);
  if (
    !requestUrl.startsWith("/") ||
    requestUrl.startsWith("//") ||
    requested.origin !== PROXY_ORIGIN
  ) {
    throw new Error("Jellyfin fault proxy target is invalid");
  }
  const target = new URL(baseUrl);
  target.pathname = requested.pathname;
  target.search = requested.search;
  target.hash = "";
  return target;
};

const copyResponse = (upstream: Response, body: Uint8Array, response: ServerResponse): void => {
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers.entries()) {
    if (name !== "content-encoding" && name !== "content-length" && name !== "transfer-encoding") {
      response.setHeader(name, value);
    }
  }
  response.end(body);
};

const observePlaybackRequest = (
  state: FaultProxyState,
  method: string,
  requestUrl: string,
): RequestObservation => {
  const isPlan = method === "POST" && requestUrl === "/Nama/v1/playback/plans";
  const isReport =
    method === "POST" &&
    requestUrl.startsWith("/Nama/v1/playback/sessions/") &&
    requestUrl.endsWith("/reports");
  if (isPlan) {
    state.planRequests += 1;
  }
  if (isReport) {
    state.reportRequests += 1;
  }
  return { isPlan, isReport };
};

const writeMalformedPlan = (response: ServerResponse, secret: string): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ plan_id: secret, tracks: "malformed" }));
};

const writeUnsafeRedirect = (response: ServerResponse): void => {
  response.statusCode = 302;
  response.setHeader("location", "https://attacker.example/playback");
  response.end();
};

const respondToPlanFault = (fault: PlanResponseFault, response: ServerResponse): void => {
  if (fault.kind === "malformed") {
    writeMalformedPlan(response, fault.secret);
    return;
  }
  if (fault.kind === "redirect") {
    writeUnsafeRedirect(response);
    return;
  }
  response.once("close", fault.cancellationObserved);
  fault.requestStarted();
};

const applyPlanResponseFault = ({ response, state, upstream }: ResponseFaultInput): boolean => {
  const fault = state.planResponseFault;
  if (fault === undefined) {
    return false;
  }
  state.planResponseFault = undefined;
  if (!upstream.ok) {
    throw new Error("Jellyfin rejected the plan selected for fault injection");
  }
  respondToPlanFault(fault, response);
  return true;
};

const applyReportResponseLoss = ({
  observation,
  response,
  state,
  upstream,
}: ReportFaultInput): boolean => {
  if (!observation.isReport || !state.loseNextReportResponse) {
    return false;
  }
  state.loseNextReportResponse = false;
  if (!upstream.ok) {
    throw new Error("Jellyfin rejected the report selected for response loss");
  }
  state.committedLostReportResponses += 1;
  response.destroy();
  return true;
};

const fetchProxiedResponse = async ({
  jellyfin,
  method,
  request,
  requestUrl,
}: ProxyRequestInput): Promise<Response> => {
  const requestOptions = {
    headers: proxyHeaders(request.headers),
    method,
    redirect: "manual" as const,
  };
  const target = proxyTarget(requestUrl, jellyfin.baseUrl);
  if (method === "GET" || method === "HEAD") {
    return fetch(target, requestOptions);
  }
  const bytes = await buffer(request);
  return fetch(target, { ...requestOptions, body: bytes.toString("utf8") });
};

const readResponseBody = async (response: Response): Promise<Uint8Array> => {
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
};

const forwardJellyfinFaultRequest = async ({
  jellyfin,
  request,
  response,
  state,
}: ProxyForwardInput): Promise<void> => {
  const method = request.method ?? "GET";
  const requestUrl = request.url ?? "/";
  const observation = observePlaybackRequest(state, method, requestUrl);
  const upstream = await fetchProxiedResponse({ jellyfin, method, request, requestUrl });
  const body = await readResponseBody(upstream);
  if (applyReportResponseLoss({ observation, response, state, upstream })) {
    return;
  }
  if (observation.isPlan && applyPlanResponseFault({ response, state, upstream })) {
    return;
  }
  copyResponse(upstream, body, response);
};

const serveFaultProxyRequest = async (input: ProxyForwardInput): Promise<void> => {
  try {
    await forwardJellyfinFaultRequest(input);
  } catch {
    if (!input.response.destroyed) {
      input.response.statusCode = HTTP_BAD_GATEWAY;
      input.response.end();
    }
  }
};

const createFaultProxyResult = (state: FaultProxyState, server: Server, port: number) => ({
  baseUrl: `http://127.0.0.1:${port}/`,
  committedLostReportResponses: () => state.committedLostReportResponses,
  loseNextReportResponse: () => {
    state.loseNextReportResponse = true;
  },
  malformNextPlanResponse: (secret: string) => {
    state.planResponseFault = { kind: "malformed" as const, secret };
  },
  planRequests: () => state.planRequests,
  redirectNextPlanResponse: () => {
    state.planResponseFault = { kind: "redirect" as const };
  },
  reportRequests: () => state.reportRequests,
  server,
  stallNextPlanResponse: () => {
    const requestStarted = Promise.withResolvers<void>();
    const cancellationObserved = Promise.withResolvers<void>();
    state.planResponseFault = {
      cancellationObserved: cancellationObserved.resolve,
      kind: "stall" as const,
      requestStarted: requestStarted.resolve,
    };
    return {
      cancellationObserved: cancellationObserved.promise,
      requestStarted: requestStarted.promise,
    };
  },
});

const startJellyfinFaultProxy = async (jellyfin: JellyfinFixture) => {
  const state: FaultProxyState = {
    committedLostReportResponses: 0,
    loseNextReportResponse: false,
    planRequests: 0,
    planResponseFault: undefined,
    reportRequests: 0,
  };
  const server = createServer((request, response) => {
    void serveFaultProxyRequest({ jellyfin, request, response, state });
  });
  server.listen(EPHEMERAL_PORT, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Jellyfin fault proxy did not bind");
  }
  return createFaultProxyResult(state, server, address.port);
};

const acquireJellyfinFaultProxy = (jellyfin: JellyfinFixture) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: (error) => {
        if (error instanceof Error) {
          return error;
        }
        return new Error("fault proxy failed");
      },
      try: () => startJellyfinFaultProxy(jellyfin),
    }),
    ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
  );

export { acquireJellyfinFaultProxy };
