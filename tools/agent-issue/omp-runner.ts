#!/usr/bin/env node

import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { OMP_MODEL, OMP_THINKING, OMP_TOOLS } from "./omp-provider.ts";

const KNOWN_EVENT_TYPES: Record<string, true> = {
  session: true,
  agent_start: true,
  agent_end: true,
  agent_error: true,
  error: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  retry_fallback_applied: true,
  retry_fallback_succeeded: true,
  model_changed: true,
  advisor_cost_changed: true,
  ttsr_triggered: true,
  todo_reminder: true,
  todo_auto_clear: true,
  irc_message: true,
  notice: true,
  thinking_level_changed: true,
  goal_updated: true,
};

const KNOWN_ASSISTANT_EVENT_TYPES: Record<string, true> = {
  start: true,
  image_end: true,
  text_start: true,
  text_delta: true,
  text_end: true,
  thinking_start: true,
  thinking_delta: true,
  thinking_end: true,
  toolcall_start: true,
  toolcall_delta: true,
  toolcall_end: true,
  done: true,
  error: true,
};

const GITHUB_CREDENTIAL_NAMES: Record<string, true> = {
  GH_TOKEN: true,
  GITHUB_TOKEN: true,
  GITHUB_PAT: true,
};

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (GITHUB_CREDENTIAL_NAMES[name] === true) {
      delete environment[name];
    }
  }
  return environment;
}

function validateProtocolLine(line: string): { type: string; agentError?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("malformed JSON record");
  }
  if (typeof raw !== "object" || raw === null || !("type" in raw) || typeof raw.type !== "string") {
    throw new Error("record lacks a string type");
  }
  if (KNOWN_EVENT_TYPES[raw.type] !== true) {
    throw new Error(`unknown event type ${raw.type}`);
  }
  if (raw.type === "message_update") {
    if (
      !("assistantMessageEvent" in raw) ||
      typeof raw.assistantMessageEvent !== "object" ||
      raw.assistantMessageEvent === null
    ) {
      throw new Error("message_update lacks assistantMessageEvent");
    }
    const assistantEvent = raw.assistantMessageEvent;
    if (!("type" in assistantEvent) || typeof assistantEvent.type !== "string") {
      throw new Error("assistantMessageEvent lacks a string type");
    }
    if (KNOWN_ASSISTANT_EVENT_TYPES[assistantEvent.type] !== true) {
      throw new Error(`unknown assistant event type ${assistantEvent.type}`);
    }
  }
  if (
    (raw.type === "agent_error" || raw.type === "error") &&
    "message" in raw &&
    typeof raw.message === "string"
  ) {
    return { type: raw.type, agentError: raw.message };
  }
  return { type: raw.type };
}

interface ChildLifecycle {
  addListener(event: "error", listener: (error: Error) => void): void;
  addListener(event: "close", listener: (code: number | null) => void): void;
}

async function main(): Promise<number> {
  const configPath = process.env["NAMA_OMP_CONFIG_PATH"];
  const pidPath = process.env["NAMA_OMP_RUNNER_PID_PATH"];
  const idleTimeoutMs = Number(process.env["NAMA_OMP_IDLE_TIMEOUT_MS"]);
  if (!configPath || !pidPath || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    process.stderr.write("OMP runner configuration is missing or invalid\n");
    return 70;
  }
  await writeFile(pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  const args = [
    "-p",
    "--mode",
    "json",
    "--model",
    OMP_MODEL,
    "--thinking",
    OMP_THINKING,
    "--no-session",
    "--no-title",
    "--no-prewalk",
    "--no-extensions",
    "--approval-mode",
    "yolo",
    "--tools",
    OMP_TOOLS.join(","),
    "--max-time",
    "60m",
    "--config",
    configPath,
  ];
  const child = spawn("omp", args, {
    cwd: process.cwd(),
    env: childEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(child.stdin);
  child.stderr.pipe(process.stderr);

  let protocolError: string | undefined;
  let agentError: string | undefined;
  let terminationError: "OMP_IDLE_TIMEOUT" | "OMP_DEADLINE" | "OMP_INTERRUPTED" | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      terminationError = "OMP_IDLE_TIMEOUT";
      child.kill("SIGTERM");
    }, idleTimeoutMs);
  };
  resetIdleTimer();
  const deadlineTimer = setTimeout(() => {
    terminationError = "OMP_DEADLINE";
    child.kill("SIGTERM");
  }, 60 * 60_000);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const consumeLines = async (): Promise<void> => {
    for await (const line of lines) {
      resetIdleTimer();
      if (protocolError) {
        continue;
      }
      try {
        const validated = validateProtocolLine(line);
        agentError ??= validated.agentError;
        process.stdout.write(`${line}\n`);
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        child.kill("SIGTERM");
      }
    }
  };
  const consumed = consumeLines();

  const forwardSignal = (signal: NodeJS.Signals): void => {
    terminationError = "OMP_INTERRUPTED";
    child.kill(signal);
  };
  process.addListener("SIGINT", forwardSignal);
  process.addListener("SIGTERM", forwardSignal);
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<number | null>();
  // TypeScript 7 loses ChildProcess's EventEmitter base on this spawn overload.
  const lifecycle = child as unknown as ChildLifecycle;
  lifecycle.addListener("error", reject);
  lifecycle.addListener("close", resolveExit);
  let exitCode: number | null;
  try {
    exitCode = await promise;
    await consumed;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
    lines.close();
    await unlink(pidPath).catch(() => {});
  }
  if (protocolError) {
    process.stderr.write(`OMP_PROTOCOL_ERROR: ${protocolError}\n`);
    return 71;
  }
  if (agentError) {
    process.stderr.write(`OMP_AGENT_ERROR: ${agentError}\n`);
    return 72;
  }
  if (terminationError) {
    process.stderr.write(`${terminationError}\n`);
    return 74;
  }
  return exitCode ?? 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `OMP_RUNNER_ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 73;
}
