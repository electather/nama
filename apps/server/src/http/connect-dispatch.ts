import { randomUUID } from "node:crypto";
import type { RequestListener } from "node:http";

import { connectNodeAdapter } from "@connectrpc/connect-node";

import { registerImplementedConnectRoutes } from "./implemented-connect-routes.ts";
import { createRequestPipeline } from "./request-pipeline.ts";
import type { RequestPipelineDependencies } from "./request-pipeline.ts";
import { registerUnimplementedConnectRoutes } from "./unimplemented-connect-routes.ts";

const HTTP_NOT_FOUND = 404;
const REQUEST_ID_HEADER = "nama-request-id";

interface ConnectRequestListenerDependencies extends RequestPipelineDependencies {
  readonly requestIdFactory?: () => string;
}

const createServerOwnedRequestListener =
  (adapter: RequestListener, requestIdFactory: () => string): RequestListener =>
  (request, response): void => {
    const requestId = requestIdFactory();
    request.headers[REQUEST_ID_HEADER] = requestId;
    // fallow-ignore-next-line security-sink -- Server-owned request ID: randomUUID by default; tests inject deterministic IDs only, and Node rejects invalid header values.
    response.setHeader(REQUEST_ID_HEADER, requestId);
    adapter(request, response);
  };

const createConnectRequestListener = ({
  requestIdFactory = randomUUID,
  ...pipelineDependencies
}: ConnectRequestListenerDependencies): RequestListener => {
  const adapter = connectNodeAdapter({
    connect: true,
    fallback: (_request, response) => {
      response.writeHead(HTTP_NOT_FOUND);
      response.end();
    },
    grpc: false,
    grpcWeb: false,
    interceptors: [createRequestPipeline(pipelineDependencies)],
    routes: (router) => {
      registerImplementedConnectRoutes(router, pipelineDependencies);
      registerUnimplementedConnectRoutes(router);
    },
  });
  return createServerOwnedRequestListener(adapter, requestIdFactory);
};

export { createConnectRequestListener };
export type { ConnectRequestListenerDependencies };
