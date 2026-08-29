import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CommandError } from "./command.ts";

export type RunStatus =
  | "running"
  | "blocked"
  | "no_change"
  | "failed"
  | "check_failed"
  | "publication_failed"
  | "published";

const RUN_STATUSES: Record<RunStatus, true> = {
  running: true,
  blocked: true,
  no_change: true,
  failed: true,
  check_failed: true,
  publication_failed: true,
  published: true,
};

export interface RunMetadata {
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
  issueLabels?: string[];
  retryMode?: "publication";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalSha(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{40}$/u.test(value));
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && Object.hasOwn(RUN_STATUSES, value);
}

export function validateRunMetadata(raw: unknown, runId: string, issueNumber: number): RunMetadata {
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
    raw.repository.length === 0 ||
    !("branch" in raw) ||
    typeof raw.branch !== "string" ||
    raw.branch.length === 0 ||
    !("baseSha" in raw) ||
    typeof raw.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(raw.baseSha) ||
    !("status" in raw) ||
    !isRunStatus(raw.status) ||
    !("runDirectory" in raw) ||
    typeof raw.runDirectory !== "string" ||
    raw.runDirectory.length === 0 ||
    !("startedAt" in raw) ||
    typeof raw.startedAt !== "string" ||
    raw.startedAt.length === 0 ||
    !("pid" in raw) ||
    typeof raw.pid !== "number" ||
    !Number.isInteger(raw.pid) ||
    raw.pid <= 0 ||
    !("worktreePath" in raw ? isOptionalString(raw.worktreePath) : true) ||
    !("headSha" in raw ? isOptionalSha(raw.headSha) : true) ||
    !("remoteSha" in raw ? isOptionalSha(raw.remoteSha) : true) ||
    !("pullRequestUrl" in raw ? isOptionalString(raw.pullRequestUrl) : true) ||
    !("failureStage" in raw ? isOptionalString(raw.failureStage) : true) ||
    !("failureCode" in raw ? isOptionalString(raw.failureCode) : true) ||
    !("attempt" in raw
      ? typeof raw.attempt === "number" && Number.isInteger(raw.attempt) && raw.attempt >= 1
      : true) ||
    !("cleanedAt" in raw ? isOptionalString(raw.cleanedAt) : true) ||
    !("issueLabels" in raw ? isOptionalStringArray(raw.issueLabels) : true) ||
    !("retryMode" in raw ? raw.retryMode === undefined || raw.retryMode === "publication" : true)
  ) {
    throw new CommandError(
      "RUN_METADATA_INVALID",
      `Run ${runId} metadata does not match issue #${issueNumber}`,
    );
  }
  const metadata: RunMetadata = {
    version: 1,
    runId,
    issueNumber,
    repository: raw.repository,
    branch: raw.branch,
    baseSha: raw.baseSha,
    startedAt: raw.startedAt,
    pid: raw.pid,
    status: raw.status,
    runDirectory: raw.runDirectory,
  };
  if ("worktreePath" in raw && typeof raw.worktreePath === "string") {
    metadata.worktreePath = raw.worktreePath;
  }
  if ("headSha" in raw && typeof raw.headSha === "string") {
    metadata.headSha = raw.headSha;
  }
  if ("remoteSha" in raw && typeof raw.remoteSha === "string") {
    metadata.remoteSha = raw.remoteSha;
  }
  if ("pullRequestUrl" in raw && typeof raw.pullRequestUrl === "string") {
    metadata.pullRequestUrl = raw.pullRequestUrl;
  }
  if ("failureStage" in raw && typeof raw.failureStage === "string") {
    metadata.failureStage = raw.failureStage;
  }
  if ("failureCode" in raw && typeof raw.failureCode === "string") {
    metadata.failureCode = raw.failureCode;
  }
  if ("attempt" in raw && typeof raw.attempt === "number") {
    metadata.attempt = raw.attempt;
  }
  if ("cleanedAt" in raw && typeof raw.cleanedAt === "string") {
    metadata.cleanedAt = raw.cleanedAt;
  }
  if (
    "issueLabels" in raw &&
    isOptionalStringArray(raw.issueLabels) &&
    raw.issueLabels !== undefined
  ) {
    metadata.issueLabels = raw.issueLabels;
  }
  if ("retryMode" in raw && raw.retryMode === "publication") {
    metadata.retryMode = raw.retryMode;
  }
  return metadata;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function loadRunMetadata(
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
