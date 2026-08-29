import type { AgentProvider, IterationUsage } from "@ai-hero/sandcastle";

const OMP_VERSION = "18.0.6";
const OMP_MODEL = "openai-codex/gpt-5.6-sol";
const OMP_THINKING = "xhigh";
const OMP_TOOLS = ["read", "bash", "edit", "write", "grep", "glob", "lsp", "todo"] as const;

interface OmpProviderOptions {
  runnerPath: string;
  configPath: string;
  pidPath: string;
  idleTimeoutMs: number;
}

interface OmpUsage {
  input?: unknown;
  cacheWrite?: unknown;
  cacheRead?: unknown;
  output?: unknown;
}

interface OmpContent {
  type?: unknown;
  text?: unknown;
}

interface OmpMessage {
  role?: unknown;
  content?: unknown;
  usage?: OmpUsage;
}

interface OmpAssistantEvent {
  type?: unknown;
  delta?: unknown;
}

interface OmpEvent {
  type: string;
  id?: unknown;
  assistantMessageEvent?: OmpAssistantEvent;
  toolName?: unknown;
  args?: unknown;
  message?: unknown;
  messages?: unknown;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readUsage(message: OmpMessage): IterationUsage | undefined {
  const usage = message.usage;
  if (!usage) {
    return undefined;
  }
  if (
    typeof usage.input !== "number" ||
    typeof usage.cacheWrite !== "number" ||
    typeof usage.cacheRead !== "number" ||
    typeof usage.output !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: usage.input,
    cacheCreationInputTokens: usage.cacheWrite,
    cacheReadInputTokens: usage.cacheRead,
    outputTokens: usage.output,
  };
}

function readAssistantResult(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // The protocol runner validates every JSON record before this parser receives it.
    const message = messages[index] as OmpMessage | undefined;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const text: string[] = [];
    for (const rawPart of message.content) {
      const part = rawPart as OmpContent;
      if (part.type === "text" && typeof part.text === "string") {
        text.push(part.text);
      }
    }
    if (text.length > 0) {
      return text.join("");
    }
  }
  return undefined;
}

function createOmpProvider(options: OmpProviderOptions): AgentProvider {
  return {
    name: `omp-${OMP_VERSION}`,
    env: {
      NAMA_OMP_CONFIG_PATH: options.configPath,
      NAMA_OMP_RUNNER_PID_PATH: options.pidPath,
      NAMA_OMP_IDLE_TIMEOUT_MS: String(options.idleTimeoutMs),
    },
    captureSessions: false,
    buildPrintCommand({ prompt }) {
      return {
        command: `${shellQuote(process.execPath)} ${shellQuote(options.runnerPath)}`,
        stdin: prompt,
      };
    },
    parseStreamLine(line) {
      // Omp-runner.ts is the protocol trust boundary and rejects malformed or unknown records.
      const parsed = JSON.parse(line) as OmpEvent;
      if (parsed.type === "session" && typeof parsed.id === "string") {
        return [{ type: "session_id", sessionId: parsed.id }];
      }
      if (parsed.type === "message_update" && parsed.assistantMessageEvent) {
        const event = parsed.assistantMessageEvent;
        if (event.type === "text_delta" && typeof event.delta === "string") {
          return [{ type: "text", text: event.delta }];
        }
        return [];
      }
      if (parsed.type === "tool_execution_start" && typeof parsed.toolName === "string") {
        return [
          { type: "tool_call", name: parsed.toolName, args: JSON.stringify(parsed.args ?? {}) },
        ];
      }
      if (
        parsed.type === "message_end" &&
        typeof parsed.message === "object" &&
        parsed.message !== null
      ) {
        const message = parsed.message as OmpMessage;
        const usage = readUsage(message);
        return usage ? [{ type: "usage", usage }] : [];
      }
      if (parsed.type === "agent_end") {
        const result = readAssistantResult(parsed.messages);
        return result ? [{ type: "result", result }] : [];
      }
      if (
        (parsed.type === "agent_error" || parsed.type === "error") &&
        typeof parsed.message === "string"
      ) {
        return [{ type: "result", result: parsed.message }];
      }
      return [];
    },
  };
}

export { createOmpProvider, OMP_MODEL, OMP_THINKING, OMP_TOOLS, OMP_VERSION };
