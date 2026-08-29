import { CommandError } from "./command.ts";

interface CompletionPolicySnapshot {
  issue: { body: string | null };
  labels: string[];
  trustedComments: Array<{ body: string }>;
}

const DEPENDENCY_PATHS: Record<string, true> = {
  "package.json": true,
  "pnpm-lock.yaml": true,
  "pnpm-workspace.yaml": true,
  "buf.yaml": true,
  "buf.lock": true,
  "apps/server/package.json": true,
  "plugins/jellyfin/package.json": true,
  "gen/ts/package.json": true,
  "go.mod": true,
  "go.sum": true,
  "gen/swift/Package.swift": true,
  "apps/ios/Nama.xcodeproj/project.pbxproj": true,
  "apps/ios/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved": true,
};

function issueAuthorizesBoundary(
  snapshot: CompletionPolicySnapshot,
  path: string,
  boundary: string,
): boolean {
  const instructions = [
    snapshot.issue.body ?? "",
    ...snapshot.trustedComments.map((comment) => comment.body),
  ].join("\n");
  const boundaryPattern = new RegExp(`\\b${boundary.replaceAll(" ", "\\s+")}\\b`, "iu");
  const positiveDirective =
    /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?(?:add|allow|authorize|bump|change|create|delete|downgrade|edit|introduce|migrate|modify|pin|regenerate|remove|replace|update|upgrade|wire)\b/iu;
  const negativeDirective =
    /\b(?:cannot|forbid|forbidden|never|no|not|prohibit|prohibited|unauthorized|without)\b|can['’]t|do not|don['’]t|must not|mustn['’]t|out of scope/iu;
  return instructions.split(/\r?\n/u).some((line) => {
    const namesBoundary = line.includes(path) || boundaryPattern.test(line);
    return namesBoundary && positiveDirective.test(line) && !negativeDirective.test(line);
  });
}

export function validateChangedPathPolicy(
  snapshot: CompletionPolicySnapshot,
  changedPaths: string[],
): void {
  const ownsXcodePath = changedPaths.some(
    (path) =>
      path.startsWith("apps/ios/") ||
      path.startsWith("gen/swift/") ||
      path.includes(".xcodeproj/") ||
      path.endsWith(".swift") ||
      path === "scripts/check-ios.sh" ||
      path === "scripts/check-swift.sh" ||
      path === ".swiftlint.yml" ||
      path === ".swiftlint-analyze.yml",
  );
  if (ownsXcodePath && !snapshot.labels.includes("requires:xcode")) {
    throw new CommandError(
      "XCODE_LABEL_MISSING",
      "Apple-owned changes require the pre-triaged requires:xcode label",
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
  for (const path of changedPaths) {
    if (DEPENDENCY_PATHS[path] === true && !issueAuthorizesBoundary(snapshot, path, "dependency")) {
      throw new CommandError(
        "DEPENDENCY_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize dependency boundary ${path}`,
      );
    }
    if (path === "mise.toml" && !issueAuthorizesBoundary(snapshot, path, "root task")) {
      throw new CommandError(
        "ROOT_TASK_CHANGE_UNAUTHORIZED",
        "Issue instructions do not authorize a root-task change",
      );
    }
    if (path.startsWith("proto/") && !issueAuthorizesBoundary(snapshot, path, "Protobuf")) {
      throw new CommandError(
        "PROTOBUF_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize ${path}`,
      );
    }
    if (
      (path.includes("/migrations/") || path.includes("/database/schema")) &&
      !issueAuthorizesBoundary(snapshot, path, "persistence")
    ) {
      throw new CommandError(
        "PERSISTENCE_CHANGE_UNAUTHORIZED",
        `Issue instructions do not authorize ${path}`,
      );
    }
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
}
