import { runCommand } from "./command.ts";

const TRUSTED_COMMENT_ASSOCIATIONS: Record<string, true> = {
  OWNER: true,
  MEMBER: true,
  COLLABORATOR: true,
};

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  issue_dependencies_summary?: { blocked_by?: number };
}

export interface GitHubComment {
  id: number;
  body: string;
  author_association: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubBlocker {
  number: number;
  title: string;
  state: string;
}

export interface IssueSnapshot {
  issue: GitHubIssue;
  labels: string[];
  blockers: GitHubBlocker[];
  acceptanceCriteria: string;
  trustedComments: GitHubComment[];
}

function extractAcceptanceCriteria(body: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/iu.test(line.trim()));
  if (start === -1) {
    return "";
  }
  const headingLevel = lines[start]?.match(/^#+/u)?.[0].length ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^(#+)\s+/u);
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

export async function readSnapshot(
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

export function meaningfulSnapshot(snapshot: IssueSnapshot): string {
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
