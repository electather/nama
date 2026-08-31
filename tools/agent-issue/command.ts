import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

function commandProcessError(
  command: string,
  args: string[],
  timeoutMs: number,
  error: unknown,
): CommandError {
  if (error instanceof Error && error.name === "AbortError") {
    return new CommandError(
      "COMMAND_TIMEOUT",
      `${command} ${args.join(" ")} exceeded its ${timeoutMs}ms timeout`,
    );
  }
  const detail =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : String(error);
  return new CommandError(
    "COMMAND_SPAWN_FAILED",
    `${command} ${args.join(" ")} could not start: ${detail}`,
  );
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; allowFailure?: boolean; timeoutMs?: number },
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      signal: AbortSignal.timeout(timeoutMs),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw commandProcessError(command, args, timeoutMs, error);
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<number | null>();
  // TypeScript 7 loses ChildProcess's EventEmitter base on this spawn overload.
  const eventfulChild = child as ChildProcess;
  eventfulChild.addListener("error", (error: Error) => {
    reject(commandProcessError(command, args, timeoutMs, error));
  });
  eventfulChild.addListener("close", resolveExit);
  const code = await promise;
  const result = { code: code ?? 1, stdout, stderr };
  if (result.code !== 0 && options.allowFailure !== true) {
    throw new CommandError(
      "COMMAND_FAILED",
      `${command} ${args.join(" ")} exited ${result.code}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return result;
}
