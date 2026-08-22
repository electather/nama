import { writeFile } from "node:fs/promises";

import { Effect } from "../apps/server/node_modules/effect/dist/index.js";
import { provisionJellyfin } from "../apps/server/integration/tests/provider-durable-loop.test-support.ts";

const outputPath = process.env.NAMA_DOCKER_PROVIDER_CONFIG;
const packagedBaseUrl = process.env.NAMA_DOCKER_JELLYFIN_URL;
if (outputPath === undefined || packagedBaseUrl === undefined) {
  throw new Error("Docker Jellyfin fixture configuration is required");
}

const fixture = await Effect.runPromise(provisionJellyfin);
await writeFile(
  outputPath,
  `${JSON.stringify({
    api_key: fixture.primaryApiKey,
    base_url: packagedBaseUrl,
    user_id: fixture.primaryUserId,
  })}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
