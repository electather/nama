import type { JellyfinFailureResponse, JellyfinRequestAuthentication } from "./request-failure.ts";

type JellyfinRequestContext = Readonly<{ apiKey: string; baseUrl: string }>;

interface JellyfinRequestOptions {
  readonly authentication: JellyfinRequestAuthentication;
  readonly cancellationSignal?: AbortSignal;
  readonly maximumResponseBytes: number;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
interface JellyfinMutationRequestOptions extends JellyfinRequestOptions {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly cancellationSignal: AbortSignal;
  readonly method: "DELETE" | "POST";
}

interface JellyfinArtworkProbeOptions {
  readonly query: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

type JellyfinRequestTarget = Readonly<{ authorization: string; baseUrl: URL }>;

type JellyfinJsonResponse =
  | {
      readonly body: Readonly<Record<string, unknown>>;
      readonly kind: "success";
    }
  | JellyfinFailureResponse;
type JellyfinMutationResponse = JellyfinJsonResponse | Readonly<{ kind: "ambiguous" }>;
interface PreparedJellyfinRequest {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
}
interface JellyfinFetchRequest {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "DELETE" | "GET" | "HEAD" | "POST";
  readonly body?: string;
  readonly signal: AbortSignal;
}
interface JellyfinRequest {
  readonly origin: string;
  readonly resourceUrl: (pathSegments: readonly string[]) => string | undefined;
  readonly probePublicArtwork: (
    pathSegments: readonly string[],
    options: JellyfinArtworkProbeOptions,
  ) => Promise<JellyfinArtworkProbeResponse>;
  readonly requestJson: (
    pathSegments: readonly string[],
    options: JellyfinRequestOptions,
  ) => Promise<JellyfinJsonResponse>;
  readonly requestMutationJson: (
    pathSegments: readonly string[],
    options: JellyfinMutationRequestOptions,
  ) => Promise<JellyfinMutationResponse>;
}

type JellyfinArtworkProbeResponse =
  | {
      readonly kind: "success";
      readonly mimeType: string;
      readonly url: string;
    }
  | JellyfinFailureResponse;

export type {
  JellyfinArtworkProbeOptions,
  JellyfinArtworkProbeResponse,
  JellyfinFetchRequest,
  JellyfinJsonResponse,
  JellyfinMutationRequestOptions,
  JellyfinMutationResponse,
  JellyfinRequest,
  JellyfinRequestContext,
  JellyfinRequestOptions,
  JellyfinRequestTarget,
  PreparedJellyfinRequest,
};
