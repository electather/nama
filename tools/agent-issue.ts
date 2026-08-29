#!/usr/bin/env node

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createWorktree, run as runSandcastle } from "@ai-hero/sandcastle";
import type { Worktree } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

import {
  createOmpProvider,
  OMP_MODEL,
  OMP_THINKING,
  OMP_VERSION,
} from "./agent-issue/omp-provider.ts";

const BRANCH_PREFIX = "agent/issue-";
const TERMINAL_CLOSE_TAG = "</nama-agent-result>";
const RUN_IDLE_TIMEOUT_SECONDS = 10 * 60;
const RUN_DEADLINE_MS = 60 * 60_000;
const OMP_CONFIG = [
  "advisor:",
  "  enabled: false",
  "async:",
  "  enabled: false",
  "bash:",
  "  autoBackground:",
  "    enabled: false",
  "eval:",
  "  autoBackground:",
  "    enabled: false",
  "task:",
  "  eager: false",
  "",
].join("\n");
const SENSITIVE_ENVIRONMENT_NAMES: Record<string, true> = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_OAUTH_TOKEN: true,
  AWS_ACCESS_KEY_ID: true,
  AWS_PROFILE: true,
  AWS_SECRET_ACCESS_KEY: true,
  AWS_SESSION_TOKEN: true,
  AZURE_OPENAI_API_KEY: true,
  GITHUB_PAT: true,
  GITHUB_TOKEN: true,
  GH_TOKEN: true,
  GOOGLE_APPLICATION_CREDENTIALS: true,
  OPENAI_API_KEY: true,
  SSH_AUTH_SOCK: true,
};
const TRUSTED_COMMENT_ASSOCIATIONS: Record<string, true> = {
  COLLABORATOR: true,
  MEMBER: true,
  OWNER: true,
};

function configuredIdleTimeoutSeconds(): number {
  if (process.env["NAMA_AGENT_TEST_MODE"] === "1") {
    const testTimeout = Number(process.env["NAMA_AGENT_TEST_IDLE_TIMEOUT_SECONDS"]);
    if (Number.isFinite(testTimeout) && testTimeout > 0) {
      return testTimeout;
    }
  }
  return RUN_IDLE_TIMEOUT_SECONDS;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  issue_dependencies_summary?: { blocked_by?: number };
}

interface GitHubComment {
  id: number;
  body: string;
  author_association: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

interface GitHubBlocker {
  number: number;
  title: string;
  state: string;
}

interface GitHubPullRequest {
  number: number;
  url: string;
  headRefName: string;
  baseRefName?: string;
  body: string;
  isDraft?: boolean;
}

interface IssueSnapshot {
  issue: GitHubIssue;
  labels: string[];
  blockers: GitHubBlocker[];
  acceptanceCriteria: string;
  trustedComments: GitHubComment[];
}

interface CliOptions {
  issueNumber: number;
  execute: boolean;
  capabilities: Set<string>;
  retryRunId?: string;
  recoverStaleLockRunId?: string;
  cleanupRunId?: string;
}

type TerminalStatus = "COMPLETE" | "BLOCKED" | "NO_CHANGE";

interface TerminalClaim {
  status: TerminalStatus;
  summary: string;
  verification: string[];
  limitations: string[];
  decision?: string;
}

type RunStatus =
  | "running"
  | "blocked"
  | "no_change"
  | "failed"
  | "check_failed"
  | "publication_failed"
  | "published";

interface RunMetadata {
  version: 1;
  runId: string;
  issueNumber: number;
  repository: string;
  branch: string;
  baseSha: string;
  startedAt: string;
  pid: number;
  status: RunStatus;
  runDirectory: string;
  worktreePath?: string;
  headSha?: string;
  remoteSha?: string;
  pullRequestUrl?: string;
  failureStage?: string;
  failureCode?: string;
  attempt?: number;
  cleanedAt?: string;
}

interface RunLock {
  version: 1;
  runId: string;
  issueNumber: number;
  branch: string;
  baseSha: string;
  pid: number;
  startedAt: string;
}

interface ExecutionContext {
  repoRoot: string;
  repository: string;
  snapshot: IssueSnapshot;
  branch: string;
  baseSha: string;
  invokingLogin: string;
  commonStateDirectory: string;
  lockPath: string;
  metadataPath: string;
  hostLogPath: string;
  agentLogPath: string;
  configPath: string;
  metadata: RunMetadata;
}

class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; allowFailure?: boolean; timeoutMs?: number },
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const { promise, resolve: resolveExit } = Promise.withResolvers<number | null>();
  // TypeScript 7 loses ChildProcess's EventEmitter base on this spawn overload.
  const eventfulChild = child as ChildProcess;
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

function parseCli(argv: string[]): CliOptions {
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
    if (issueNumber !== undefined || !argument || !/^\d+$/.test(argument)) {
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

function extractAcceptanceCriteria(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()));
  if (start === -1) {
    return "";
  }
  const headingLevel = lines[start]?.match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^(#+)\s+/);
    if ((heading?.[1]?.length ?? Number.POSITIVE_INFINITY) <= headingLevel) {
      end = index;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

async function readSnapshot(
  repoRoot: string,
  repository: string,
  issueNumber: number,
): Promise<IssueSnapshot> {
  const issueResult = await runCommand("gh", ["api", `repos/${repository}/issues/${issueNumber}`], {
    cwd: repoRoot,
  });
  const commentResult = await runCommand(
    "gh",
    ["api", `repos/${repository}/issues/${issueNumber}/comments`, "--paginate"],
    { cwd: repoRoot },
  );
  const blockerResult = await runCommand(
    "gh",
    ["api", `repos/${repository}/issues/${issueNumber}/dependencies/blocked_by`, "--paginate"],
    { cwd: repoRoot },
  );
  const issue = JSON.parse(issueResult.stdout) as GitHubIssue;
  const comments = JSON.parse(commentResult.stdout) as GitHubComment[];
  const blockers = JSON.parse(blockerResult.stdout) as GitHubBlocker[];
  return {
    issue,
    labels: issue.labels.map((label) => label.name).sort(),
    blockers,
    acceptanceCriteria: extractAcceptanceCriteria(issue.body ?? ""),
    trustedComments: comments.filter(
      (comment) => TRUSTED_COMMENT_ASSOCIATIONS[comment.author_association] === true,
    ),
  };
}

async function verifyXcode(repoRoot: string): Promise<void> {
  const xcode = await runCommand("xcodebuild", ["-version"], { cwd: repoRoot, allowFailure: true });
  const versionMatch = /^Xcode\s+(\d+)(?:\.|$)/m.exec(xcode.stdout);
  if (xcode.code !== 0 || !versionMatch || Number(versionMatch[1]) < 26) {
    throw new CommandError(
      "XCODE_UNUSABLE",
      "requires:xcode needs a usable Xcode 26 or newer toolchain",
    );
  }
  const sdk = await runCommand("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"], {
    cwd: repoRoot,
    allowFailure: true,
  });
  const sdkMajor = Number.parseInt(sdk.stdout.trim().split(".")[0] ?? "", 10);
  if (sdk.code !== 0 || !Number.isFinite(sdkMajor) || sdkMajor < 26) {
    throw new CommandError(
      "XCODE_SDK_UNUSABLE",
      "requires:xcode needs the repository's iPhoneOS 26 SDK",
    );
  }
}

async function admit(
  repoRoot: string,
  _repository: string,
  snapshot: IssueSnapshot,
  branch: string,
  capabilities: ReadonlySet<string>,
  allowRecordedRetry = false,
): Promise<void> {
  const { issue, labels, blockers } = snapshot;
  if (issue.state.toLowerCase() !== "open") {
    throw new CommandError("ISSUE_CLOSED", `Issue #${issue.number} is not open`);
  }
  if (!labels.includes("ready-for-agent")) {
    throw new CommandError("ISSUE_NOT_READY", `Issue #${issue.number} lacks ready-for-agent`);
  }
  if (issue.assignees.length > 0) {
    throw new CommandError("ISSUE_ASSIGNED", `Issue #${issue.number} is already assigned`);
  }
  if (
    (issue.issue_dependencies_summary?.blocked_by ?? blockers.length) > 0 ||
    blockers.length > 0
  ) {
    throw new CommandError("ISSUE_BLOCKED", `Issue #${issue.number} has an open native blocker`);
  }
  if (labels.includes("requires:xcode")) {
    if (!capabilities.has("xcode")) {
      throw new CommandError("CAPABILITY_MISMATCH", `Issue #${issue.number} requires:xcode`);
    }
    await verifyXcode(repoRoot);
  }
  if (allowRecordedRetry) {
    return;
  }
  const remoteBranch = await runCommand(
    "git",
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: repoRoot, allowFailure: true },
  );
  if (remoteBranch.code === 0 && remoteBranch.stdout.trim().length > 0) {
    throw new CommandError(
      "BRANCH_EXISTS",
      `Implementation branch ${branch} already exists on origin`,
    );
  }
  const localBranch = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    {
      cwd: repoRoot,
      allowFailure: true,
    },
  );
  if (localBranch.code === 0) {
    throw new CommandError(
      "BRANCH_EXISTS",
      `Implementation branch ${branch} already exists locally`,
    );
  }
  const prResult = await runCommand(
    "gh",
    ["pr", "list", "--state", "open", "--json", "number,url,headRefName,body"],
    { cwd: repoRoot },
  );
  const pullRequests = JSON.parse(prResult.stdout) as GitHubPullRequest[];
  const issueReference = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue.number}\\b`,
    "i",
  );
  if (
    pullRequests.some(
      (pullRequest) => pullRequest.headRefName === branch || issueReference.test(pullRequest.body),
    )
  ) {
    throw new CommandError(
      "PULL_REQUEST_EXISTS",
      `Issue #${issue.number} already has an open implementation pull request`,
    );
  }
}

function meaningfulSnapshot(snapshot: IssueSnapshot): string {
  return JSON.stringify({
    number: snapshot.issue.number,
    title: snapshot.issue.title,
    body: snapshot.issue.body,
    state: snapshot.issue.state,
    labels: snapshot.labels,
    blockers: snapshot.blockers.map((blocker) => ({
      number: blocker.number,
      title: blocker.title,
      state: blocker.state,
    })),
    trustedComments: snapshot.trustedComments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      login: comment.user?.login,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
  });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function recordRun(
  context: ExecutionContext,
  event: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await appendFile(
    context.hostLogPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...detail })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function saveMetadata(context: ExecutionContext): Promise<void> {
  await atomicWriteJson(context.metadataPath, context.metadata);
}

function populatedSensitiveEnvironment(): string[] {
  return Object.keys(SENSITIVE_ENVIRONMENT_NAMES)
    .filter((name) => typeof process.env[name] === "string" && process.env[name] !== "")
    .sort();
}

async function verifyOmpVersion(repoRoot: string): Promise<void> {
  const result = await runCommand("omp", ["--version"], { cwd: repoRoot, allowFailure: true });
  const normalized = result.stdout.trim();
  if (
    result.code !== 0 ||
    (normalized !== `omp/${OMP_VERSION}` && normalized !== `omp v${OMP_VERSION}`)
  ) {
    throw new CommandError(
      "OMP_VERSION_MISMATCH",
      `Expected exact omp ${OMP_VERSION}, received ${normalized || "no version"}`,
    );
  }
}

async function resolveCommonStateDirectory(repoRoot: string): Promise<string> {
  const commonResult = await runCommand("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
  });
  return join(resolve(repoRoot, commonResult.stdout.trim()), "nama-agent");
}

function validateRunMetadata(raw: unknown, runId: string, issueNumber: number): RunMetadata {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("version" in raw) ||
    raw.version !== 1 ||
    !("runId" in raw) ||
    raw.runId !== runId ||
    !("issueNumber" in raw) ||
    raw.issueNumber !== issueNumber ||
    !("repository" in raw) ||
    typeof raw.repository !== "string" ||
    !("branch" in raw) ||
    typeof raw.branch !== "string" ||
    !("baseSha" in raw) ||
    typeof raw.baseSha !== "string" ||
    !("status" in raw) ||
    typeof raw.status !== "string" ||
    !("runDirectory" in raw) ||
    typeof raw.runDirectory !== "string" ||
    !("startedAt" in raw) ||
    typeof raw.startedAt !== "string" ||
    !("pid" in raw) ||
    typeof raw.pid !== "number"
  ) {
    throw new CommandError(
      "RUN_METADATA_INVALID",
      `Run ${runId} metadata does not match issue #${issueNumber}`,
    );
  }
  return raw as RunMetadata;
}

async function loadRunMetadata(
  commonStateDirectory: string,
  runId: string,
  issueNumber: number,
): Promise<{ metadata: RunMetadata; metadataPath: string }> {
  const metadataPath = join(commonStateDirectory, "runs", runId, "metadata.json");
  let raw: string;
  try {
    raw = await readFile(metadataPath, "utf8");
  } catch {
    throw new CommandError(
      "RUN_NOT_FOUND",
      `No recorded run ${runId} exists for issue #${issueNumber}`,
    );
  }
  return {
    metadata: validateRunMetadata(JSON.parse(raw) as unknown, runId, issueNumber),
    metadataPath,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function recoverStaleLock(
  repoRoot: string,
  issueNumber: number,
  runId: string,
): Promise<void> {
  const commonStateDirectory = await resolveCommonStateDirectory(repoRoot);
  const lockPath = join(commonStateDirectory, "active-run.json");
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    throw new CommandError("LOCK_NOT_FOUND", "No active run lock exists");
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("runId" in parsed) ||
    parsed.runId !== runId ||
    !("issueNumber" in parsed) ||
    parsed.issueNumber !== issueNumber ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number"
  ) {
    throw new CommandError(
      "LOCK_MISMATCH",
      "Active lock does not match the requested run and issue",
    );
  }
  await loadRunMetadata(commonStateDirectory, runId, issueNumber);
  if (processIsAlive(parsed.pid)) {
    throw new CommandError(
      "LOCK_PROCESS_ALIVE",
      `Run ${runId} still belongs to live process ${parsed.pid}`,
    );
  }
  await unlink(lockPath);
  process.stdout.write(
    `Recovered stale lock for ${runId} after confirming process ${parsed.pid} is dead.\n`,
  );
}

async function cleanupRecordedRun(
  repoRoot: string,
  issueNumber: number,
  runId: string,
): Promise<void> {
  const commonStateDirectory = await resolveCommonStateDirectory(repoRoot);
  const { metadata, metadataPath } = await loadRunMetadata(
    commonStateDirectory,
    runId,
    issueNumber,
  );
  if (metadata.status === "running" || metadata.status === "published") {
    throw new CommandError(
      "CLEANUP_STATUS_INVALID",
      `Run ${runId} status ${metadata.status} is not eligible for explicit cleanup`,
    );
  }
  const lockPath = join(commonStateDirectory, "active-run.json");
  try {
    const lockRaw = await readFile(lockPath, "utf8");
    const lock: unknown = JSON.parse(lockRaw);
    if (typeof lock === "object" && lock !== null && "runId" in lock && lock.runId === runId) {
      throw new CommandError("CLEANUP_LOCKED", `Run ${runId} still owns the active lock`);
    }
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  if (!metadata.worktreePath) {
    throw new CommandError("CLEANUP_METADATA_MISMATCH", "Run metadata lacks a worktree path");
  }
  const worktreePath = resolve(metadata.worktreePath);
  const expectedRoot = `${resolve(repoRoot, ".sandcastle/worktrees")}/`;
  if (!worktreePath.startsWith(expectedRoot)) {
    throw new CommandError(
      "CLEANUP_METADATA_MISMATCH",
      "Recorded worktree is outside Nama's Sandcastle worktree directory",
    );
  }
  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (branchResult.code !== 0 || branchResult.stdout.trim() !== metadata.branch) {
    throw new CommandError(
      "CLEANUP_METADATA_MISMATCH",
      "Recorded worktree no longer owns the recorded branch",
    );
  }
  if (metadata.headSha) {
    const headResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    if (headResult.stdout.trim() !== metadata.headSha) {
      throw new CommandError(
        "CLEANUP_METADATA_MISMATCH",
        "Recorded worktree HEAD differs from run metadata",
      );
    }
  }
  const remote = await runCommand(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${metadata.branch}`],
    { cwd: worktreePath, allowFailure: true },
  );
  if (remoteBranchSha(remote.stdout)) {
    throw new CommandError(
      "CLEANUP_REMOTE_EXISTS",
      "Explicit cleanup refuses a run whose remote branch exists",
    );
  }
  await runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
  await runCommand("git", ["branch", "-D", metadata.branch], { cwd: repoRoot });
  metadata.cleanedAt = new Date().toISOString();
  await atomicWriteJson(metadataPath, metadata);
  process.stdout.write(`Cleaned recorded worktree and branch for ${runId}.\n`);
}

async function createRetryExecutionContext(
  repoRoot: string,
  repository: string,
  snapshot: IssueSnapshot,
  runId: string,
): Promise<ExecutionContext> {
  const sensitiveEnvironment = populatedSensitiveEnvironment();
  if (sensitiveEnvironment.length > 0) {
    throw new CommandError(
      "SENSITIVE_ENVIRONMENT",
      `Unset sensitive inherited environment variables before execution: ${sensitiveEnvironment.join(", ")}`,
    );
  }
  await verifyOmpVersion(repoRoot);
  const commonStateDirectory = await resolveCommonStateDirectory(repoRoot);
  const { metadata, metadataPath } = await loadRunMetadata(
    commonStateDirectory,
    runId,
    snapshot.issue.number,
  );
  if (
    metadata.repository !== repository ||
    metadata.branch !== `${BRANCH_PREFIX}${snapshot.issue.number}`
  ) {
    throw new CommandError(
      "RETRY_METADATA_MISMATCH",
      "Recorded run repository or branch does not match this issue",
    );
  }
  if (!["failed", "check_failed", "publication_failed"].includes(metadata.status)) {
    throw new CommandError(
      "RETRY_STATUS_INVALID",
      `Run ${runId} status ${metadata.status} is not retryable`,
    );
  }
  if (!metadata.worktreePath) {
    throw new CommandError("RETRY_METADATA_MISMATCH", "Recorded run lacks a worktree");
  }
  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: metadata.worktreePath,
    allowFailure: true,
  });
  if (branchResult.code !== 0 || branchResult.stdout.trim() !== metadata.branch) {
    throw new CommandError(
      "RETRY_METADATA_MISMATCH",
      "Preserved worktree does not own the recorded branch",
    );
  }
  const baseAncestry = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", metadata.baseSha, "HEAD"],
    { cwd: metadata.worktreePath, allowFailure: true },
  );
  if (baseAncestry.code !== 0) {
    throw new CommandError(
      "RETRY_STALE_BASE",
      "Recorded base is not an ancestor of the preserved worktree",
    );
  }
  const remote = await runCommand(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${metadata.branch}`],
    { cwd: metadata.worktreePath, allowFailure: true },
  );
  const remoteSha = remoteBranchSha(remote.stdout);
  if (remoteSha && remoteSha !== metadata.remoteSha) {
    throw new CommandError(
      "RETRY_REMOTE_MISMATCH",
      "Remote branch is not the SHA recorded by the failed run",
    );
  }
  const existingPullRequests = await queryBranchPullRequests({
    repoRoot,
    branch: metadata.branch,
  });
  if (existingPullRequests.length > 0) {
    throw new CommandError(
      "RETRY_PULL_REQUEST_EXISTS",
      "A pull request already exists for the recorded branch",
    );
  }
  const loginResult = await runCommand("gh", ["api", "user"], { cwd: repoRoot });
  const loginPayload = JSON.parse(loginResult.stdout) as { login?: unknown };
  if (typeof loginPayload.login !== "string" || loginPayload.login.length === 0) {
    throw new CommandError("GITHUB_IDENTITY_INVALID", "gh api user did not return a login");
  }
  const startedAt = new Date().toISOString();
  const lockPath = join(commonStateDirectory, "active-run.json");
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock: RunLock = {
    version: 1,
    runId,
    issueNumber: snapshot.issue.number,
    branch: metadata.branch,
    baseSha: metadata.baseSha,
    pid: process.pid,
    startedAt,
  };
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new CommandError(
        "CONCURRENT_RUN",
        `An active Nama issue run is recorded at ${lockPath}`,
      );
    }
    throw error;
  } finally {
    await lockHandle?.close();
  }
  metadata.status = "running";
  metadata.pid = process.pid;
  metadata.attempt = (metadata.attempt ?? 1) + 1;
  delete metadata.failureStage;
  delete metadata.failureCode;
  const runDirectory = metadata.runDirectory;
  const configPath = join(runDirectory, "omp-config.yml");
  await writeFile(configPath, OMP_CONFIG, { encoding: "utf8", mode: 0o600 });
  const context: ExecutionContext = {
    repoRoot,
    repository,
    snapshot,
    branch: metadata.branch,
    baseSha: metadata.baseSha,
    invokingLogin: loginPayload.login,
    commonStateDirectory,
    lockPath,
    metadataPath,
    hostLogPath: join(runDirectory, "host.jsonl"),
    agentLogPath: join(runDirectory, `agent-attempt-${metadata.attempt}.log`),
    configPath,
    metadata,
  };
  await saveMetadata(context);
  await recordRun(context, "run.retry_started", { attempt: metadata.attempt });
  return context;
}

async function createExecutionContext(
  repoRoot: string,
  repository: string,
  snapshot: IssueSnapshot,
  branch: string,
  baseSha: string,
): Promise<ExecutionContext> {
  const sensitiveEnvironment = populatedSensitiveEnvironment();
  if (sensitiveEnvironment.length > 0) {
    throw new CommandError(
      "SENSITIVE_ENVIRONMENT",
      `Unset sensitive inherited environment variables before execution: ${sensitiveEnvironment.join(", ")}`,
    );
  }
  await verifyOmpVersion(repoRoot);
  const loginResult = await runCommand("gh", ["api", "user"], { cwd: repoRoot });
  const loginPayload = JSON.parse(loginResult.stdout) as { login?: unknown };
  if (typeof loginPayload.login !== "string" || loginPayload.login.length === 0) {
    throw new CommandError("GITHUB_IDENTITY_INVALID", "gh api user did not return a login");
  }
  const commonResult = await runCommand("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
  });
  const commonDirectory = resolve(repoRoot, commonResult.stdout.trim());
  const commonStateDirectory = join(commonDirectory, "nama-agent");
  const runId = `issue-${snapshot.issue.number}-${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(commonStateDirectory, "runs", runId);
  const lockPath = join(commonStateDirectory, "active-run.json");
  const metadataPath = join(runDirectory, "metadata.json");
  const hostLogPath = join(runDirectory, "host.jsonl");
  const agentLogPath = join(runDirectory, "agent.log");
  const configPath = join(runDirectory, "omp-config.yml");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath, OMP_CONFIG, { encoding: "utf8", mode: 0o600 });
  const startedAt = new Date().toISOString();
  const metadata: RunMetadata = {
    version: 1,
    runId,
    issueNumber: snapshot.issue.number,
    repository,
    branch,
    baseSha,
    startedAt,
    pid: process.pid,
    status: "running",
    runDirectory,
  };
  const lock: RunLock = {
    version: 1,
    runId,
    issueNumber: snapshot.issue.number,
    branch,
    baseSha,
    pid: process.pid,
    startedAt,
  };
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new CommandError(
        "CONCURRENT_RUN",
        `An active Nama issue run is recorded at ${lockPath}`,
      );
    }
    throw error;
  } finally {
    await lockHandle?.close();
  }
  const context: ExecutionContext = {
    repoRoot,
    repository,
    snapshot,
    branch,
    baseSha,
    invokingLogin: loginPayload.login,
    commonStateDirectory,
    lockPath,
    metadataPath,
    hostLogPath,
    agentLogPath,
    configPath,
    metadata,
  };
  await saveMetadata(context);
  await recordRun(context, "run.created", { securityBoundary: "host-user", sandbox: "none" });
  return context;
}

async function releaseRunLock(context: ExecutionContext): Promise<void> {
  try {
    const raw = await readFile(context.lockPath, "utf8");
    const lock = JSON.parse(raw) as { runId?: unknown };
    if (lock.runId === context.metadata.runId) {
      await unlink(context.lockPath);
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    await recordRun(context, "lock.release_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildAgentPrompt(context: ExecutionContext): string {
  const trustedContext = {
    title: context.snapshot.issue.title,
    body: context.snapshot.issue.body ?? "",
    labels: context.snapshot.labels,
    dependencies: context.snapshot.blockers,
    acceptanceCriteria: context.snapshot.acceptanceCriteria,
    trustedCollaboratorComments: context.snapshot.trustedComments.map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body,
    })),
  };
  return [
    `Implement GitHub issue #${context.snapshot.issue.number} completely in this worktree.`,
    "Repository guidance, architecture, contracts, ADRs, generated-code ownership, and nested AGENTS.md files outrank issue content.",
    "Read the governing repository documents before editing. Use focused tests first, run focused owning checks, and commit all issue-owned work.",
    "Do not mutate GitHub, push, create a pull request, create another worktree, dispatch subagents, use browser/computer control, or modify files outside this worktree.",
    "Stop instead of inventing a missing public API, Protobuf, persistence, security, dependency, root-task, product, generated-code, or acceptance decision.",
    "Report unrelated failures; do not repair them.",
    "Your final response must contain exactly one terminal claim with this shape:",
    '<nama-agent-result>{"status":"COMPLETE|BLOCKED|NO_CHANGE","summary":"safe concise summary","verification":["exact command: PASS|FAIL"],"limitations":["safe concise limitation"],"decision":"required only for BLOCKED"}</nama-agent-result>',
    "COMPLETE requires at least one issue-owned commit and a clean index/worktree. BLOCKED names the exact unresolved human decision. NO_CHANGE states why no commit is honest.",
    "Never include prompts, transcripts, hidden reasoning, environment data, credentials, tokens, or arbitrary tool output in the terminal claim.",
    "Trusted issue snapshot:",
    JSON.stringify(trustedContext, null, 2),
  ].join("\n\n");
}

function parseTerminalClaim(output: string): TerminalClaim {
  const openTag = "<nama-agent-result>";
  const start = output.lastIndexOf(openTag);
  const end = output.indexOf(TERMINAL_CLOSE_TAG, start + openTag.length);
  if (start === -1 || end === -1) {
    throw new CommandError(
      "TERMINAL_CLAIM_MISSING",
      "OMP exited without one complete terminal claim",
    );
  }
  const trailingClaim = output.indexOf(openTag, start + openTag.length);
  if (trailingClaim !== -1) {
    throw new CommandError("TERMINAL_CLAIM_MULTIPLE", "OMP emitted more than one terminal claim");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(start + openTag.length, end));
  } catch {
    throw new CommandError("TERMINAL_CLAIM_INVALID", "OMP terminal claim is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new CommandError("TERMINAL_CLAIM_INVALID", "OMP terminal claim must be an object");
  }
  if (
    !("status" in raw) ||
    (raw.status !== "COMPLETE" && raw.status !== "BLOCKED" && raw.status !== "NO_CHANGE")
  ) {
    throw new CommandError("TERMINAL_CLAIM_INVALID", "OMP terminal claim has an unknown status");
  }
  if (!("summary" in raw) || typeof raw.summary !== "string") {
    throw new CommandError("TERMINAL_CLAIM_INVALID", "OMP terminal claim lacks a summary");
  }
  if (
    !("verification" in raw) ||
    !Array.isArray(raw.verification) ||
    !raw.verification.every((entry) => typeof entry === "string") ||
    !("limitations" in raw) ||
    !Array.isArray(raw.limitations) ||
    !raw.limitations.every((entry) => typeof entry === "string")
  ) {
    throw new CommandError(
      "TERMINAL_CLAIM_INVALID",
      "OMP terminal claim has invalid evidence arrays",
    );
  }
  const claim: TerminalClaim = {
    status: raw.status,
    summary: raw.summary,
    verification: raw.verification,
    limitations: raw.limitations,
  };
  if ("decision" in raw) {
    if (typeof raw.decision !== "string") {
      throw new CommandError("TERMINAL_CLAIM_INVALID", "OMP BLOCKED decision must be text");
    }
    claim.decision = raw.decision;
  }
  if (claim.status === "BLOCKED" && (!claim.decision || claim.decision.trim().length === 0)) {
    throw new CommandError(
      "TERMINAL_CLAIM_INVALID",
      "OMP BLOCKED claim lacks the unresolved decision",
    );
  }
  return claim;
}

function safePublicText(value: string): string {
  const compact = value.replaceAll(/\s+/g, " ").trim().slice(0, 500);
  if (
    /(?:token|password|credential|environment dump|prompt|transcript|hidden reasoning)/i.test(
      compact,
    )
  ) {
    return "Withheld by automation publication policy.";
  }
  return compact || "None recorded.";
}

async function failRun(context: ExecutionContext, stage: string, code: string): Promise<void> {
  let status: RunStatus = "failed";
  if (stage === "host-check") {
    status = "check_failed";
  } else if (stage === "publication") {
    status = "publication_failed";
  }
  context.metadata.status = status;
  context.metadata.failureStage = stage;
  context.metadata.failureCode = code;
  await saveMetadata(context);
  await recordRun(context, "run.failed", { stage, code });
  const comment = `Automated run ${context.metadata.runId} stopped at \`${stage}\`: \`${code}\`. Local recovery state was retained.`;
  await runCommand(
    "gh",
    ["issue", "comment", String(context.snapshot.issue.number), "--body", comment],
    { cwd: context.repoRoot, allowFailure: true },
  );
  await runCommand(
    "gh",
    [
      "issue",
      "edit",
      String(context.snapshot.issue.number),
      "--remove-assignee",
      context.invokingLogin,
    ],
    { cwd: context.repoRoot, allowFailure: true },
  );
}

async function transitionToHuman(context: ExecutionContext, claim: TerminalClaim): Promise<void> {
  context.metadata.status = claim.status === "BLOCKED" ? "blocked" : "no_change";
  await saveMetadata(context);
  const detail =
    claim.status === "BLOCKED"
      ? `Blocked decision: ${safePublicText(claim.decision ?? "")}`
      : `No change: ${safePublicText(claim.summary)} Verification: mise run check — PASS.`;
  await runCommand(
    "gh",
    [
      "issue",
      "edit",
      String(context.snapshot.issue.number),
      "--remove-assignee",
      context.invokingLogin,
      "--remove-label",
      "ready-for-agent",
      "--add-label",
      "ready-for-human",
    ],
    { cwd: context.repoRoot },
  );
  await runCommand(
    "gh",
    [
      "issue",
      "comment",
      String(context.snapshot.issue.number),
      "--body",
      `Automated run ${context.metadata.runId}. ${detail}`,
    ],
    { cwd: context.repoRoot },
  );
  await recordRun(context, "run.human_transition", { status: claim.status });
}

function issueAuthorizesBoundary(snapshot: IssueSnapshot, path: string, boundary: string): boolean {
  const instructions = `${snapshot.issue.body ?? ""}\n${snapshot.trustedComments.map((comment) => comment.body).join("\n")}`;
  return instructions.includes(path) || new RegExp(`\\b${boundary}\\b`, "i").test(instructions);
}

async function validateCompleteResult(context: ExecutionContext): Promise<string[]> {
  const worktreePath = context.metadata.worktreePath;
  if (!worktreePath) {
    throw new CommandError("WORKTREE_MISSING", "Run metadata lacks its worktree");
  }
  const commitCount = await runCommand("git", ["rev-list", "--count", `${context.baseSha}..HEAD`], {
    cwd: worktreePath,
  });
  if (Number(commitCount.stdout.trim()) < 1) {
    throw new CommandError(
      "COMPLETE_WITHOUT_COMMIT",
      "COMPLETE requires at least one commit beyond the recorded base",
    );
  }
  const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: worktreePath,
  });
  if (status.stdout.trim().length > 0) {
    throw new CommandError("COMPLETE_DIRTY", "COMPLETE requires a clean index and worktree");
  }
  const mergeCommits = await runCommand(
    "git",
    ["rev-list", "--merges", `${context.baseSha}..HEAD`],
    { cwd: worktreePath },
  );
  if (mergeCommits.stdout.trim().length > 0) {
    throw new CommandError("MERGE_COMMIT_REJECTED", "Agent results may not contain merge commits");
  }
  const changedResult = await runCommand(
    "git",
    ["diff", "--name-only", `${context.baseSha}..HEAD`],
    {
      cwd: worktreePath,
    },
  );
  const changedPaths = changedResult.stdout.split("\n").filter((path) => path.length > 0);
  const ownsXcodePath = changedPaths.some(
    (path) =>
      path.startsWith("apps/ios/") ||
      path.startsWith("gen/swift/") ||
      path.includes(".xcodeproj/") ||
      path.endsWith(".swift"),
  );
  if (ownsXcodePath && !context.snapshot.labels.includes("requires:xcode")) {
    throw new CommandError(
      "XCODE_LABEL_MISSING",
      "Apple-owned changes require the pre-triaged requires:xcode label",
    );
  }
  if (
    changedPaths.some((path) => path.startsWith("gen/")) &&
    !changedPaths.some((path) => path.startsWith("proto/") || path.startsWith("buf."))
  ) {
    throw new CommandError(
      "GENERATED_OWNER_MISSING",
      "Generated bindings changed without their owning schema or generator",
    );
  }
  if (
    changedPaths.includes("apps/server/src/database/auth-schema.ts") &&
    !changedPaths.includes("apps/server/better-auth.config.ts")
  ) {
    throw new CommandError(
      "AUTH_SCHEMA_OWNER_MISSING",
      "Generated auth schema changed without its owning configuration",
    );
  }
  const dependencyPaths: Record<string, true> = {
    "package.json": true,
    "pnpm-lock.yaml": true,
    "go.mod": true,
    "go.sum": true,
    "gen/swift/Package.resolved": true,
  };
  for (const path of changedPaths) {
    if (
      dependencyPaths[path] === true &&
      !issueAuthorizesBoundary(context.snapshot, path, "dependency")
    ) {
      throw new CommandError(
        "DEPENDENCY_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize dependency boundary ${path}`,
      );
    }
    if (path === "mise.toml" && !issueAuthorizesBoundary(context.snapshot, path, "root task")) {
      throw new CommandError(
        "ROOT_TASK_CHANGE_UNAUTHORIZED",
        "Issue instructions do not authorize a root-task change",
      );
    }
    if (path.startsWith("proto/") && !issueAuthorizesBoundary(context.snapshot, path, "Protobuf")) {
      throw new CommandError(
        "PROTOBUF_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize ${path}`,
      );
    }
    if (
      (path.includes("/migrations/") || path.includes("/database/schema")) &&
      !issueAuthorizesBoundary(context.snapshot, path, "persistence")
    ) {
      throw new CommandError(
        "PERSISTENCE_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize ${path}`,
      );
    }
  }
  const headResult = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  context.metadata.headSha = headResult.stdout.trim();
  await saveMetadata(context);
  return changedPaths;
}

async function runHostCheck(context: ExecutionContext): Promise<void> {
  const worktreePath = context.metadata.worktreePath;
  if (!worktreePath) {
    throw new CommandError("WORKTREE_MISSING", "Run metadata lacks its worktree");
  }
  const check = await runCommand("mise", ["run", "check"], {
    cwd: worktreePath,
    allowFailure: true,
    timeoutMs: 2 * 60 * 60_000,
  });
  await appendFile(
    context.hostLogPath,
    `${JSON.stringify({ event: "host.check.output", stdout: check.stdout, stderr: check.stderr, exitCode: check.code })}\n`,
    "utf8",
  );
  if (check.code !== 0) {
    throw new CommandError("HOST_CHECK_FAILED", "mise run check failed");
  }
  await recordRun(context, "host.check_passed", { command: "mise run check" });
}

async function revalidateBeforePublication(context: ExecutionContext): Promise<void> {
  const current = await readSnapshot(
    context.repoRoot,
    context.repository,
    context.snapshot.issue.number,
  );
  if (meaningfulSnapshot(current) !== meaningfulSnapshot(context.snapshot)) {
    throw new CommandError(
      "ISSUE_CHANGED",
      "Instruction-relevant issue state changed during execution",
    );
  }
  const assignees = current.issue.assignees.map((assignee) => assignee.login).sort();
  if (assignees.length !== 1 || assignees[0] !== context.invokingLogin) {
    throw new CommandError("ASSIGNMENT_CHANGED", "Issue assignment changed during execution");
  }
  await runCommand("git", ["fetch", "--prune", "origin", "main"], {
    cwd: context.repoRoot,
    timeoutMs: 120_000,
  });
  const currentBase = await runCommand("git", ["rev-parse", "origin/main"], {
    cwd: context.repoRoot,
  });
  if (currentBase.stdout.trim() === context.baseSha) {
    return;
  }
  const worktreePath = context.metadata.worktreePath;
  if (!worktreePath) {
    throw new CommandError("WORKTREE_MISSING", "Run metadata lacks its worktree");
  }
  const mergeTree = await runCommand("git", ["merge-tree", "--write-tree", "HEAD", "origin/main"], {
    cwd: worktreePath,
    allowFailure: true,
    timeoutMs: 120_000,
  });
  if (mergeTree.code !== 0) {
    throw new CommandError(
      "BASE_CONFLICT",
      "origin/main advanced with a conflict; automatic merge and rebase are prohibited",
    );
  }
  await recordRun(context, "base.advanced_without_conflict", {
    currentBase: currentBase.stdout.trim(),
  });
}

function remoteBranchSha(output: string): string | undefined {
  const firstLine = output.trim().split("\n")[0];
  if (!firstLine) {
    return undefined;
  }
  const sha = firstLine.split(/\s+/)[0];
  return /^[0-9a-f]{40}$/.test(sha ?? "") ? sha : undefined;
}

async function queryBranchPullRequests(
  context: Pick<ExecutionContext, "repoRoot" | "branch">,
): Promise<GitHubPullRequest[]> {
  const result = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      context.branch,
      "--json",
      "number,url,isDraft,headRefName,baseRefName,body",
    ],
    { cwd: context.repoRoot },
  );
  return JSON.parse(result.stdout) as GitHubPullRequest[];
}

async function publish(context: ExecutionContext, claim: TerminalClaim): Promise<string> {
  const worktreePath = context.metadata.worktreePath;
  const localSha = context.metadata.headSha;
  if (!worktreePath || !localSha) {
    throw new CommandError("PUBLICATION_STATE_INVALID", "Publication lacks worktree commit state");
  }
  const remoteBefore = await runCommand(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${context.branch}`],
    { cwd: worktreePath, allowFailure: true },
  );
  const existingRemoteSha = remoteBranchSha(remoteBefore.stdout);
  let pushArguments: string[] | undefined;
  if (!existingRemoteSha) {
    pushArguments = ["push", "origin", `HEAD:refs/heads/${context.branch}`];
  } else if (existingRemoteSha !== localSha) {
    if ((context.metadata.attempt ?? 1) <= 1 || context.metadata.remoteSha !== existingRemoteSha) {
      throw new CommandError(
        "REMOTE_BRANCH_DIVERGED",
        "Deterministic remote branch contains unrecorded work",
      );
    }
    const lease = `--force-with-lease=refs/heads/${context.branch}:${existingRemoteSha}`;
    pushArguments = ["push", lease, "origin", `HEAD:refs/heads/${context.branch}`];
    await recordRun(context, "publication.force_with_lease", {
      expectedRemoteSha: existingRemoteSha,
    });
  }
  if (pushArguments) {
    const push = await runCommand("git", pushArguments, {
      cwd: worktreePath,
      allowFailure: true,
      timeoutMs: 120_000,
    });
    const remoteAfter = await runCommand(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${context.branch}`],
      { cwd: worktreePath, allowFailure: true },
    );
    const confirmedSha = remoteBranchSha(remoteAfter.stdout);
    if (confirmedSha !== localSha) {
      throw new CommandError(
        "PUSH_UNCONFIRMED",
        `Branch push was not confirmed after exit ${push.code}`,
      );
    }
  }
  context.metadata.remoteSha = localSha;
  await saveMetadata(context);
  await recordRun(context, "publication.branch_confirmed", { sha: localSha });

  let pullRequests = await queryBranchPullRequests(context);
  if (pullRequests.length > 1) {
    throw new CommandError(
      "PULL_REQUEST_AMBIGUOUS",
      "Multiple pull requests use the deterministic branch",
    );
  }
  if (pullRequests.length === 0) {
    const bodyPath = join(context.metadata.runDirectory, "pull-request-body.txt");
    const focusedEvidence = claim.verification
      .map((entry) => `- ${safePublicText(entry)}`)
      .join("\n");
    const limitations =
      claim.limitations.length > 0
        ? claim.limitations.map((entry) => `- ${safePublicText(entry)}`).join("\n")
        : "- None recorded.";
    const body = [
      "## Summary",
      safePublicText(claim.summary),
      "",
      "## Verification",
      "- `mise run check` — PASS",
      focusedEvidence,
      "",
      "## Limitations",
      limitations,
      "",
      "## Automation provenance",
      `- Run: \`${context.metadata.runId}\``,
      `- Agent: OMP ${OMP_VERSION}, \`${OMP_MODEL}\`, thinking \`${OMP_THINKING}\``,
      "- Generated by Nama's local Sandcastle no-sandbox issue executor under the invoking user's host authority.",
      "",
      `Closes #${context.snapshot.issue.number}`,
      "",
    ].join("\n");
    await writeFile(bodyPath, body, { encoding: "utf8", mode: 0o600 });
    await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        "main",
        "--head",
        context.branch,
        "--title",
        context.snapshot.issue.title,
        "--body-file",
        bodyPath,
      ],
      { cwd: context.repoRoot, allowFailure: true, timeoutMs: 120_000 },
    );
    pullRequests = await queryBranchPullRequests(context);
  }
  const pullRequest = pullRequests[0];
  if (
    !pullRequest ||
    pullRequest.headRefName !== context.branch ||
    pullRequest.baseRefName !== "main" ||
    pullRequest.isDraft !== true ||
    !new RegExp(`\\bCloses\\s+#${context.snapshot.issue.number}\\b`, "i").test(pullRequest.body)
  ) {
    throw new CommandError(
      "PULL_REQUEST_UNCONFIRMED",
      "Matching draft pull request was not confirmed remotely",
    );
  }
  context.metadata.pullRequestUrl = pullRequest.url;
  await saveMetadata(context);
  await recordRun(context, "publication.pull_request_confirmed", { url: pullRequest.url });
  await runCommand(
    "gh",
    [
      "issue",
      "edit",
      String(context.snapshot.issue.number),
      "--remove-label",
      "ready-for-agent",
      "--add-assignee",
      context.invokingLogin,
    ],
    { cwd: context.repoRoot },
  );
  context.metadata.status = "published";
  await saveMetadata(context);
  return pullRequest.url;
}

async function terminateOmpRunner(context: ExecutionContext): Promise<void> {
  const pidPath = join(context.metadata.runDirectory, "omp-runner.pid");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // The runner may not have started yet or may already have exited.
  }
}

async function executeIssue(
  repoRoot: string,
  repository: string,

  snapshot: IssueSnapshot,
  branch: string,
  baseSha: string,
  retryRunId?: string,
): Promise<void> {
  const context = retryRunId
    ? await createRetryExecutionContext(repoRoot, repository, snapshot, retryRunId)
    : await createExecutionContext(repoRoot, repository, snapshot, branch, baseSha);
  let worktree: Worktree | undefined;
  let claimed = false;
  let stage = "claim";
  try {
    process.stdout.write(
      "SECURITY: noSandbox() grants OMP the invoking macOS user's host-user authority; this run is not filesystem or credential isolation.\n",
    );
    await runCommand(
      "gh",
      ["issue", "edit", String(snapshot.issue.number), "--add-assignee", "@me"],
      { cwd: repoRoot },
    );
    claimed = true;
    await recordRun(context, "issue.claimed", { login: context.invokingLogin });

    if (!retryRunId) {
      stage = "worktree";
      worktree = await createWorktree({
        cwd: repoRoot,
        branchStrategy: { type: "branch", branch, baseBranch: "origin/main" },
      });
      context.metadata.worktreePath = worktree.worktreePath;
      await saveMetadata(context);
      await recordRun(context, "worktree.created", { path: worktree.worktreePath });
    }

    stage = "agent";
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new CommandError("AGENT_DEADLINE", "OMP exceeded the sixty-minute overall deadline"),
      );
      void terminateOmpRunner(context);
    }, RUN_DEADLINE_MS);
    const interrupt = (): void => {
      controller.abort(new CommandError("INTERRUPTED", "Operator interrupted the active OMP run"));
      void terminateOmpRunner(context);
    };
    process.addListener("SIGINT", interrupt);
    process.addListener("SIGTERM", interrupt);
    let result;
    try {
      const runnerPath = join(import.meta.dirname, "agent-issue/omp-runner.ts");
      const idleTimeoutSeconds = configuredIdleTimeoutSeconds();
      const runOptions = {
        agent: createOmpProvider({
          runnerPath,
          configPath: context.configPath,
          pidPath: join(context.metadata.runDirectory, "omp-runner.pid"),
          idleTimeoutMs: idleTimeoutSeconds * 1000,
        }),
        sandbox: noSandbox(),
        prompt: buildAgentPrompt(context),
        maxIterations: 1,
        completionSignal: TERMINAL_CLOSE_TAG,
        idleTimeoutSeconds: idleTimeoutSeconds + 1,
        completionTimeoutSeconds: 30,
        name: context.metadata.runId,
        logging: { type: "file" as const, path: context.agentLogPath, verbose: true },
        signal: controller.signal,
      };
      if (worktree) {
        result = await worktree.run(runOptions);
      } else {
        if (!context.metadata.worktreePath) {
          throw new CommandError(
            "RETRY_METADATA_MISMATCH",
            "Recorded retry lacks a preserved worktree",
          );
        }
        result = await runSandcastle({
          ...runOptions,
          cwd: context.metadata.worktreePath,
          branchStrategy: { type: "head" },
        });
      }
    } finally {
      clearTimeout(deadline);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    if (result.completionSignal !== TERMINAL_CLOSE_TAG) {
      throw new CommandError("TERMINAL_CLAIM_MISSING", "OMP stopped without a terminal claim");
    }
    const claim = parseTerminalClaim(result.stdout);
    await recordRun(context, "agent.claim", { status: claim.status });

    if (claim.status === "BLOCKED") {
      await transitionToHuman(context, claim);
      process.stdout.write(
        `Run ${context.metadata.runId} returned BLOCKED; worktree retained for human review.\n`,
      );
      return;
    }
    if (claim.status === "NO_CHANGE") {
      stage = "host-check";
      await runHostCheck(context);
      await transitionToHuman(context, claim);
      process.stdout.write(
        `Run ${context.metadata.runId} returned NO_CHANGE; evidence and worktree retained.\n`,
      );
      return;
    }

    stage = "validation";
    await validateCompleteResult(context);
    stage = "host-check";
    await runHostCheck(context);
    stage = "revalidation";
    await revalidateBeforePublication(context);
    stage = "publication";
    const pullRequestUrl = await publish(context, claim);
    const successfulWorktreePath = context.metadata.worktreePath;
    if (worktree) {
      await worktree.close();
    } else if (successfulWorktreePath) {
      await runCommand("git", ["worktree", "remove", successfulWorktreePath], { cwd: repoRoot });
    }
    await recordRun(context, "worktree.cleaned", { path: successfulWorktreePath });
    process.stdout.write(`Confirmed draft pull request: ${pullRequestUrl}\n`);
  } catch (error) {
    const code = error instanceof CommandError ? error.code : "EXECUTION_FAILED";
    if (claimed) {
      if (code === "XCODE_LABEL_MISSING") {
        await transitionToHuman(context, {
          status: "BLOCKED",
          decision:
            "Apply requires:xcode during human triage before retrying Apple-owned implementation.",
          summary: "Apple-owned changes were produced without the required capability label.",
          verification: [],
          limitations: [],
        });
      } else {
        await failRun(context, stage, code);
      }
    }
    throw error;
  } finally {
    await releaseRunLock(context);
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const cwd = process.cwd();
  const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  const repoRoot = resolve(cwd, rootResult.stdout.trim());
  if (options.recoverStaleLockRunId) {
    await recoverStaleLock(repoRoot, options.issueNumber, options.recoverStaleLockRunId);
    return;
  }
  if (options.cleanupRunId) {
    await cleanupRecordedRun(repoRoot, options.issueNumber, options.cleanupRunId);
    return;
  }
  const repositoryResult = await runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], {
    cwd: repoRoot,
  });
  const repository = (JSON.parse(repositoryResult.stdout) as { nameWithOwner: string })
    .nameWithOwner;
  await runCommand("git", ["fetch", "--prune", "origin", "main"], {
    cwd: repoRoot,
    timeoutMs: 120_000,
  });
  const baseResult = await runCommand("git", ["rev-parse", "origin/main"], { cwd: repoRoot });
  const snapshot = await readSnapshot(repoRoot, repository, options.issueNumber);
  const branch = `${BRANCH_PREFIX}${options.issueNumber}`;
  await admit(
    repoRoot,
    repository,
    snapshot,
    branch,
    options.capabilities,
    options.retryRunId !== undefined,
  );

  if (options.execute) {
    await executeIssue(
      repoRoot,
      repository,
      snapshot,
      branch,
      baseResult.stdout.trim(),
      options.retryRunId,
    );
    return;
  }

  const comments = snapshot.trustedComments
    .map((comment) => `@${comment.user?.login ?? "unknown"}`)
    .join(", ");
  process.stdout.write(
    `${[
      `PLAN issue #${options.issueNumber}: ${snapshot.issue.title}`,
      `base: ${baseResult.stdout.trim()}`,
      `branch: ${branch}`,
      `capabilities: ${snapshot.labels.includes("requires:xcode") ? "xcode (verified)" : "baseline"}`,
      `model: ${OMP_MODEL}`,
      `thinking: ${OMP_THINKING}`,
      `omp: ${OMP_VERSION}`,
      "agent iterations: 1",
      "idle timeout: 10 minutes",
      "overall deadline: 60 minutes",
      "host check: mise run check",
      `trusted collaborator comments: ${comments || "none"}`,
      "GitHub mutations on --execute: assign, safe status comment when needed, push deterministic branch, create draft PR, remove ready-for-agent after remote confirmation",
      "SECURITY: Sandcastle noSandbox() grants OMP the invoking macOS user's host-user authority; it is not filesystem or credential isolation.",
      "Dry plan complete: no assignment, label, branch, worktree, push, pull request, or OMP process was created.",
    ].join("\n")}\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof CommandError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`UNEXPECTED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
