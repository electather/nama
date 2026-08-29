import { CommandError } from "./command.ts";

export const TERMINAL_CLOSE_TAG = "</nama-agent-result>";

export type TerminalStatus = "COMPLETE" | "BLOCKED" | "NO_CHANGE";

export interface TerminalClaim {
  status: TerminalStatus;
  summary: string;
  verification: string[];
  limitations: string[];
  decision?: string;
}

export function parseTerminalClaim(output: string): TerminalClaim {
  const openTag = "<nama-agent-result>";
  const start = output.indexOf(openTag);
  const end = output.indexOf(TERMINAL_CLOSE_TAG);
  if (start === -1 || end === -1 || end < start + openTag.length) {
    throw new CommandError(
      "TERMINAL_CLAIM_MISSING",
      "OMP exited without one complete terminal claim",
    );
  }
  if (start !== output.lastIndexOf(openTag) || end !== output.lastIndexOf(TERMINAL_CLOSE_TAG)) {
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

export function safePublicText(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim().slice(0, 500);
  if (
    /(?:token|password|credential|environment dump|prompt|transcript|hidden reasoning)/iu.test(
      compact,
    )
  ) {
    return "Withheld by automation publication policy.";
  }
  return compact || "None recorded.";
}
