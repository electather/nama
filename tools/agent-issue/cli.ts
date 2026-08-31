import { CommandError } from "./command.ts";

export interface CliOptions {
  issueNumber: number;
  execute: boolean;
  capabilities: Set<string>;
  retryRunId?: string;
  recoverStaleLockRunId?: string;
  cleanupRunId?: string;
}

export function parseCli(argv: string[]): CliOptions {
  let issueNumber: number | undefined;
  let execute = false;
  let retryRunId: string | undefined;
  let recoverStaleLockRunId: string | undefined;
  let cleanupRunId: string | undefined;
  const capabilities = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (
      argument === "--capability" ||
      argument === "--retry" ||
      argument === "--recover-stale-lock" ||
      argument === "--cleanup"
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new CommandError("USAGE", `${argument} requires a value`);
      }
      if (argument === "--capability") {
        capabilities.add(value);
      }
      if (argument === "--retry") {
        retryRunId = value;
      }
      if (argument === "--recover-stale-lock") {
        recoverStaleLockRunId = value;
      }
      if (argument === "--cleanup") {
        cleanupRunId = value;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("--capability=")) {
      capabilities.add(argument.slice("--capability=".length));
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new CommandError("USAGE", `Unknown option: ${argument}`);
    }
    if (issueNumber !== undefined || !argument || !/^\d+$/u.test(argument)) {
      throw new CommandError("USAGE", "Provide exactly one GitHub issue number");
    }
    issueNumber = Number(argument);
  }
  if (issueNumber === undefined || issueNumber <= 0) {
    throw new CommandError(
      "USAGE",
      "Usage: pnpm agent:issue -- <issue> [--execute] [--capability xcode] [--retry RUN_ID] [--recover-stale-lock RUN_ID] [--cleanup RUN_ID]",
    );
  }
  for (const capability of capabilities) {
    if (capability !== "xcode") {
      throw new CommandError("CAPABILITY_UNKNOWN", `Unknown runner capability: ${capability}`);
    }
  }
  const maintenanceActions = [recoverStaleLockRunId, cleanupRunId].filter(
    (value) => value !== undefined,
  );
  if (maintenanceActions.length > 1 || (maintenanceActions.length > 0 && (execute || retryRunId))) {
    throw new CommandError("USAGE", "Recovery and cleanup actions must run alone");
  }
  if (retryRunId && !execute) {
    throw new CommandError("USAGE", "--retry requires --execute");
  }
  return {
    issueNumber,
    execute,
    capabilities,
    ...(retryRunId ? { retryRunId } : {}),
    ...(recoverStaleLockRunId ? { recoverStaleLockRunId } : {}),
    ...(cleanupRunId ? { cleanupRunId } : {}),
  };
}
