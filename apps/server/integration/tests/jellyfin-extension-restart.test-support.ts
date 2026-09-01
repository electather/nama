import { execFile } from "node:child_process";

const COMPOSE_TIMEOUT_MILLISECONDS = 60_000;
const PORT_TIMEOUT_MILLISECONDS = 10_000;

const executeDocker = (arguments_: readonly string[], timeout: number): Promise<string> => {
  const { promise, reject, resolve } = Promise.withResolvers<string>();
  execFile(
    "docker",
    arguments_,
    { encoding: "utf8", timeout },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node execFile exposes completion only through its callback; this bridges it into one Promise.
    (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    },
  );
  return promise;
};

const restartJellyfin = async (serviceName = "jellyfin"): Promise<string> => {
  const composeFile = process.env["NAMA_TEST_JELLYFIN_COMPOSE_FILE"];
  const project = process.env["NAMA_TEST_JELLYFIN_COMPOSE_PROJECT"];
  if (composeFile === undefined || project === undefined) {
    throw new Error("Jellyfin Compose restart context is unavailable");
  }
  const commonArguments = ["compose", "--project-name", project, "--file", composeFile];
  await executeDocker([...commonArguments, "restart", serviceName], COMPOSE_TIMEOUT_MILLISECONDS);
  await executeDocker(
    [...commonArguments, "up", "--detach", "--wait", serviceName],
    COMPOSE_TIMEOUT_MILLISECONDS,
  );
  const publishedAddress = await executeDocker(
    [...commonArguments, "port", serviceName, "8096"],
    PORT_TIMEOUT_MILLISECONDS,
  );
  return `http://${publishedAddress.trim()}/`;
};

export { restartJellyfin };
