import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { Effect } from "effect";

import {
  copyResponse,
  fetchProxiedResponse,
  proxyHeaders,
} from "./jellyfin-fault-proxy-http.test-support.ts";
import type { ProxyRequestInput } from "./jellyfin-fault-proxy-http.test-support.ts";
import { createProgressFaultController } from "./jellyfin-progress-fault.test-support.ts";
import type {
  ProgressFaultController,
  ProgressFaultRequest,
} from "./jellyfin-progress-fault.test-support.ts";
import type { JellyfinFixture } from "./provider-durable-loop.test-support.ts";

const EPHEMERAL_PORT = 0;
const HTTP_BAD_GATEWAY = 502;

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
  progress: ProgressFaultController;
  reportRequests: number;
}

interface RequestObservation {
  readonly isPlan: boolean;
  readonly isProgress: boolean;
  readonly isReport: boolean;
}

interface ProxyForwardInput {
  readonly jellyfin: JellyfinFixture;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly state: FaultProxyState;
}

interface ResponseFaultInput {
  readonly response: ServerResponse;
  readonly state: FaultProxyState;
  readonly upstream: Response;
}

interface ReportFaultInput extends ResponseFaultInput {
  readonly observation: RequestObservation;
}

const observePlaybackRequest = (
  state: FaultProxyState,
  method: string,
  requestUrl: string,
): RequestObservation => {
  const isPlan = method === "POST" && requestUrl === "/Nama/v1/playback/plans";
  const isProgress = state.progress.observe(method, requestUrl);
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
  return { isPlan, isProgress, isReport };
};
const observeProxyRequest = (state: FaultProxyState, request: IncomingMessage) => {
  const method = request.method ?? "GET";
  const requestUrl = request.url ?? "/";
  return {
    method,
    observation: observePlaybackRequest(state, method, requestUrl),
    requestUrl,
  };
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
const applyForwardedResponseFault = (input: ReportFaultInput): boolean => {
  if (applyReportResponseLoss(input)) {
    return true;
  }
  if (
    input.state.progress.applyResponseLoss(
      input.observation.isProgress,
      input.response,
      input.upstream,
    )
  ) {
    return true;
  }
  return input.observation.isPlan && applyPlanResponseFault(input);
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
  const { method, observation, requestUrl } = observeProxyRequest(state, request);
  if (
    state.progress.applyFailure({
      isProgress: observation.isProgress,
      method,
      requestUrl,
      response,
    } satisfies ProgressFaultRequest)
  ) {
    return;
  }
  const headers = state.progress.upstreamHeaders(
    observation.isProgress,
    proxyHeaders(request.headers),
  );
  const upstream = await fetchProxiedResponse({
    baseUrl: jellyfin.baseUrl,
    headers,
    method,
    request,
    requestUrl,
  } satisfies ProxyRequestInput);
  const body = await readResponseBody(upstream);
  if (applyForwardedResponseFault({ observation, response, state, upstream })) {
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
  committedLostProgressResponses: state.progress.committedLostResponses,
  committedLostReportResponses: () => state.committedLostReportResponses,
  failNextExtensionProgressPersistence: state.progress.failNextExtensionPersistence,
  failNextExtensionProgressReadback: state.progress.failNextExtensionReadback,
  failNextProgressReadback: state.progress.failNextReadbackResponse,
  failNextProgressResponse: state.progress.failNextResponse,
  loseNextProgressResponse: state.progress.loseNextResponse,
  loseNextReportResponse: () => {
    state.loseNextReportResponse = true;
  },
  malformNextPlanResponse: (secret: string) => {
    state.planResponseFault = { kind: "malformed" as const, secret };
  },
  planRequests: () => state.planRequests,
  progressRequests: state.progress.requests,
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
    progress: createProgressFaultController(),
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
