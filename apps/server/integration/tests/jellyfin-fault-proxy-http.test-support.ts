import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";

const PROXY_ORIGIN = "http://proxy.invalid";
interface ProxyRequestInput {
  readonly baseUrl: string;
  readonly headers: Headers;
  readonly method: string;
  readonly request: IncomingMessage;
  readonly requestUrl: string;
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
const fetchProxiedResponse = async ({
  baseUrl,
  headers,
  method,
  request,
  requestUrl,
}: ProxyRequestInput): Promise<Response> => {
  const requestOptions = { headers, method, redirect: "manual" as const };
  const target = proxyTarget(requestUrl, baseUrl);
  if (method === "GET" || method === "HEAD") {
    return fetch(target, requestOptions);
  }
  const bytes = await buffer(request);
  return fetch(target, { ...requestOptions, body: bytes.toString("utf8") });
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

export { copyResponse, fetchProxiedResponse, proxyHeaders };
export type { ProxyRequestInput };
