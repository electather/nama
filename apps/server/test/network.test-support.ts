import { once } from "node:events";
import { createServer } from "node:http";

import { Effect } from "effect";

const HOST = "127.0.0.1";
const EPHEMERAL_PORT = 0;

const withReservedPort = <Result, Error, Requirements>(
  use: (port: number) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(createServer),
    (reservation) =>
      Effect.gen(function* reservedPort() {
        yield* Effect.promise(async () => {
          reservation.listen(EPHEMERAL_PORT, HOST);
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

const reservePort = withReservedPort(Effect.succeed);

export { EPHEMERAL_PORT, HOST, reservePort, withReservedPort };
