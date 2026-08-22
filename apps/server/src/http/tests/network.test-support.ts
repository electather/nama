import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

const HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const SHORT_DELAY_MILLISECONDS = 25;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const EXPECTED_READINESS_TRANSITIONS = 2;

interface CapturedSocket {
  readonly location: URL;
  readonly read: () => string;
  readonly socket: Socket;
}

const expectEmptyResponse = (response: Response, status: number) =>
  Effect.gen(function* emptyResponseAssertion() {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-length")).toBe("0");
    expect(yield* Effect.promise(() => response.text())).toBe("");
  });
const withHostPortReservation = <Result, Error, Requirements>(
  port: number,
  host: string,
  use: (port: number) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(createServer),
    (reservation) =>
      Effect.gen(function* reservedPort() {
        yield* Effect.promise(async () => {
          reservation.listen(port, host);
          await once(reservation, "listening");
        });
        const address = reservation.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new TypeError("expected an internet socket"));
        }
        return yield* use(address.port);
      }),
    (reservation) => Effect.promise(() => reservation[Symbol.asyncDispose]()),
  );
const withPortReservation = <Result, Error, Requirements>(
  port: number,
  use: (port: number) => Effect.Effect<Result, Error, Requirements>,
) => withHostPortReservation(port, HOST, use);

const withReservedPort = <Result, Error, Requirements>(
  use: (port: number) => Effect.Effect<Result, Error, Requirements>,
) => withPortReservation(EPHEMERAL_PORT, use);

const reservePort = withReservedPort(Effect.succeed);
const reservePortOn = (host: string) =>
  withHostPortReservation(EPHEMERAL_PORT, host, Effect.succeed);
const reserveSpecificPort = (port: number) => withPortReservation(port, () => Effect.void);

const openCapturedSocket = (origin: string) =>
  Effect.gen(function* capturedSocket() {
    const location = new URL(origin);
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => connect(Number(location.port), location.hostname)),
      (acquired) =>
        Effect.sync(() => {
          acquired.destroy();
        }),
    );
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    yield* Effect.promise(() => once(socket, "connect"));
    return { location, read: () => received, socket };
  });

const sendReadyRequest = (client: CapturedSocket, connection: "close" | "keep-alive") =>
  Effect.sync(() => {
    client.socket.write(
      `GET /health/ready HTTP/1.1\r\nHost: ${client.location.host}\r\nConnection: ${connection}\r\n\r\n`,
    );
  });

const statusesFrom = (received: string): (string | undefined)[] =>
  [...received.matchAll(/HTTP\/1\.1 (?<status>\d{3})/gu)].map((match) => match.groups?.["status"]);

const waitForShortDelay = Effect.sleep(SHORT_DELAY_MILLISECONDS);

const waitForSocketClose = (client: CapturedSocket) =>
  Effect.promise(() => once(client.socket, "close"));

export {
  EPHEMERAL_PORT,
  EXPECTED_READINESS_TRANSITIONS,
  HOST,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  expectEmptyResponse,
  openCapturedSocket,
  reservePort,
  reservePortOn,
  reserveSpecificPort,
  sendReadyRequest,
  statusesFrom,
  waitForShortDelay,
  waitForSocketClose,
  withReservedPort,
};
export type { CapturedSocket };
