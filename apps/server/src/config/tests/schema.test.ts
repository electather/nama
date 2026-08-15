import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import {
  BYTE_LENGTH_OFFSET,
  DATABASE_URL,
  MASTER_KEY_BYTES,
  MASTER_KEY,
  MAXIMUM_BYTE,
  MAXIMUM_CONNECTIONS,
  MINIMUM_CONNECTIONS,
  expectValidationError,
  loadToml,
  rejectToml,
  validToml,
} from "./config.test-support.ts";

it.effect.each(["localhost:1", "nama.internal:65535", "127.0.0.1:8080", "[::1]:8080"])(
  "accepts the bind %s",
  (bind) =>
    Effect.gen(function* validBindTest() {
      const config = yield* loadToml(validToml(), { NAMA_BIND: bind });
      expect(config.server.bind).toBe(bind);
    }),
);

it.effect.each([
  "",
  "localhost",
  "localhost:0",
  "localhost:65536",
  "999.1.1.1:80",
  "-bad.example:80",
  "::1:80",
  "[not-ipv6]:80",
])("rejects the bind %s", (bind) =>
  expectValidationError(rejectToml(validToml(), { NAMA_BIND: bind })),
);

it.effect.each([
  "",
  "nama.example",
  "ftp://nama.example",
  "https://user:pass@nama.example",
  "https://nama.example/path",
  "https://nama.example?query=secret",
  "https://nama.example/#fragment",
])("rejects the public URL %s", (url) =>
  expectValidationError(rejectToml(validToml(), { NAMA_PUBLIC_URL: url })),
);

it.effect.each([
  [String(MINIMUM_CONNECTIONS), MINIMUM_CONNECTIONS],
  [String(MAXIMUM_CONNECTIONS), MAXIMUM_CONNECTIONS],
] as const)("accepts max_connections %s", ([encoded, expected]) =>
  Effect.gen(function* validConnectionCountTest() {
    const database = `url = "${DATABASE_URL}"\nmax_connections = ${encoded}`;
    const config = yield* loadToml(validToml({ database }));
    expect(config.database.maxConnections).toBe(expected);
  }),
);

it.effect.each(["0", "1.5", "101"])("rejects max_connections %s", (encoded) => {
  const database = `url = "${DATABASE_URL}"\nmax_connections = ${encoded}`;
  return expectValidationError(rejectToml(validToml({ database })));
});

it.effect("accepts a strict standard base64 key decoding to 32 bytes", () =>
  Effect.gen(function* validMasterKeyTest() {
    const encoded = Buffer.alloc(MASTER_KEY_BYTES, MAXIMUM_BYTE).toString("base64");
    const accepted = `base64:${encoded}`;
    const config = yield* loadToml(validToml(), { NAMA_MASTER_KEY: accepted });
    expect(Redacted.value(config.security.masterKey)).toBe(accepted);
  }),
);

it.effect.each([
  "",
  Buffer.alloc(MASTER_KEY_BYTES).toString("base64"),
  `base64:${Buffer.alloc(MASTER_KEY_BYTES - BYTE_LENGTH_OFFSET).toString("base64")}`,
  `base64:${Buffer.alloc(MASTER_KEY_BYTES + BYTE_LENGTH_OFFSET).toString("base64")}`,
  `base64:${Buffer.alloc(MASTER_KEY_BYTES, MAXIMUM_BYTE).toString("base64url")}`,
  `base64:${Buffer.alloc(MASTER_KEY_BYTES).toString("base64")}junk`,
])("rejects an invalid master key", (masterKey) =>
  expectValidationError(rejectToml(validToml(), { NAMA_MASTER_KEY: masterKey })),
);

it.effect.each(["", "INFO", "warning", "none"])("rejects the log level %s", (level) =>
  expectValidationError(rejectToml(validToml(), { NAMA_LOG_LEVEL: level })),
);

it.effect("rejects a non-string public URL", () => {
  const server = 'public_url = ["https://nama.example"]';
  return expectValidationError(rejectToml(validToml({ server })));
});

it.effect("does not let an override hide a malformed section", () =>
  expectValidationError(
    rejectToml(
      `server = ["wrong-type"]

[database]
url = "${DATABASE_URL}"

[security]
master_key = "${MASTER_KEY}"
`,
      { NAMA_PUBLIC_URL: "https://nama.example" },
    ),
  ),
);
