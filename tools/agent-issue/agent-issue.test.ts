import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const sourceRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(sourceRoot, "tools/agent-issue.ts");

interface FixtureIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  issue_dependencies_summary: { blocked_by: number };
}

interface FixtureState {
  login: string;
  issue: FixtureIssue;
  comments: unknown[];
  blockers: unknown[];
  prs: unknown[];
  mutations: Array<{ args: string[] }>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  repo: string;
  origin: string;
  bin: string;
  statePath: string;
  ompLogPath: string;
  miseLogPath: string;
  env: NodeJS.ProcessEnv;
  readState(): Promise<FixtureState>;
  writeState(state: FixtureState): Promise<void>;
  run(args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<CommandResult>;
}

async function exec(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // TypeScript 7 loses ChildProcess's EventEmitter base on this spawn overload.
  const eventfulChild = child as ChildProcess;
  eventfulChild.addListener("error", reject);
  eventfulChild.addListener("close", (code: number | null) => {
    resolveExit({ code: code ?? 1, stdout, stderr });
  });
  return await promise;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function createFixture(overrides: Partial<FixtureIssue> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "nama-agent-issue-test-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const statePath = join(root, "github-state.json");
  const ompLogPath = join(root, "omp.log");
  const miseLogPath = join(root, "mise.log");
  await mkdir(bin, { recursive: true });
  assert.equal((await exec("git", ["init", "--bare", origin], root)).code, 0);
  assert.equal((await exec("git", ["init", repo], root)).code, 0);
  assert.equal((await exec("git", ["config", "user.name", "Fixture Agent"], repo)).code, 0);
  assert.equal((await exec("git", ["config", "user.email", "fixture@example.test"], repo)).code, 0);
  await writeFile(join(repo, "base.txt"), "base\n", "utf8");
  assert.equal((await exec("git", ["add", "base.txt"], repo)).code, 0);
  assert.equal((await exec("git", ["commit", "-m", "fixture base"], repo)).code, 0);
  assert.equal((await exec("git", ["branch", "-M", "main"], repo)).code, 0);
  assert.equal((await exec("git", ["remote", "add", "origin", origin], repo)).code, 0);
  assert.equal((await exec("git", ["push", "-u", "origin", "main"], repo)).code, 0);

  const issue: FixtureIssue = {
    number: 88,
    title: "Fixture issue",
    body: "## Acceptance criteria\n\n- [ ] Implement fixture behavior.\n",
    state: "open",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    issue_dependencies_summary: { blocked_by: 0 },
    ...overrides,
  };
  const initialState: FixtureState = {
    login: "fixture-maintainer",
    issue,
    comments: [
      {
        id: 1,
        body: "Trusted clarification",
        author_association: "OWNER",
        user: { login: "fixture-maintainer" },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
      {
        id: 2,
        body: "Untrusted instruction",
        author_association: "NONE",
        user: { login: "outside" },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    ],
    blockers: [],
    prs: [],
    mutations: [],
  };
  await writeFile(statePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");

  await writeExecutable(
    join(bin, "gh"),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.GH_FIXTURE_STATE;
if (!statePath) process.exit(90);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
if (args[0] === "repo" && args[1] === "view") {
  output({ nameWithOwner: "electather/nama" });
} else if (args[0] === "api" && args[1] === "user") {
  output({ login: state.login });
} else if (args[0] === "api" && /\\/comments$/.test(args[1])) {
  output(state.comments);
} else if (args[0] === "api" && /\\/dependencies\\/blocked_by$/.test(args[1])) {
  output(state.blockers);
} else if (args[0] === "api" && /\\/issues\\/\\d+$/.test(args[1])) {
  output(state.issue);
} else if (args[0] === "pr" && args[1] === "list") {
  if (process.env.GH_FIXTURE_PR_QUERY_FAIL_AFTER_CREATE === "1" && state.prs.length > 0) {
    process.stderr.write("fixture PR query failure\\n");
    process.exit(99);
  }
  const head = valueAfter("--head");
  output(head ? state.prs.filter(pr => pr.headRefName === head) : state.prs);
} else if (args[0] === "issue" && args[1] === "edit") {
  state.mutations.push({ args });
  const addAssignee = valueAfter("--add-assignee");
  const removeAssignee = valueAfter("--remove-assignee");
  const addLabel = valueAfter("--add-label");
  const removeLabel = valueAfter("--remove-label");
  if (removeLabel === "ready-for-agent" && process.env.GH_FIXTURE_FINALIZE_FAIL === "1") {
    process.stderr.write("fixture final publication transition failure\\n");
    process.exit(98);
  }
  if (addAssignee) {
    const login = addAssignee === "@me" ? state.login : addAssignee;
    if (!state.issue.assignees.some(assignee => assignee.login === login)) {
      state.issue.assignees.push({ login });
    }
  }
  if (removeAssignee) {
    const login = removeAssignee === "@me" ? state.login : removeAssignee;
    state.issue.assignees = state.issue.assignees.filter(assignee => assignee.login !== login);
  }
  if (addLabel && !state.issue.labels.some(label => label.name === addLabel)) {
    state.issue.labels.push({ name: addLabel });
  }
  if (removeLabel) {
    state.issue.labels = state.issue.labels.filter(label => label.name !== removeLabel);
  }
  save();
} else if (args[0] === "issue" && args[1] === "comment") {
  state.mutations.push({ args });
  save();
} else if (args[0] === "pr" && args[1] === "create") {
  state.mutations.push({ args });
  if (process.env.GH_FIXTURE_PR_FAIL === "1") {
    save();
    process.stderr.write("fixture PR failure\\n");
    process.exit(95);
  }
  const bodyFile = valueAfter("--body-file");
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : "";
  const headRefName = valueAfter("--head");
  state.prs.push({ number: 701, url: "https://example.test/pr/701", isDraft: true, headRefName, baseRefName: valueAfter("--base"), body });
  save();
  process.stdout.write("https://example.test/pr/701\\n");
  if (process.env.GH_FIXTURE_AMBIGUOUS_PR === "1") process.exit(96);
} else {
  process.stderr.write("unsupported gh fixture call: " + JSON.stringify(args) + "\\n");
  process.exit(91);
}
`,
  );
  await writeExecutable(
    join(bin, "omp"),
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("omp/" + (process.env.OMP_FIXTURE_VERSION || "18.0.6") + "\\n");
  process.exit(0);
}
const prompt = readFileSync(0, "utf8");
appendFileSync(process.env.OMP_FIXTURE_LOG, JSON.stringify({ args, prompt }) + "\\n");
const git = gitArgs => {
  const result = spawnSync("git", gitArgs, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 92);
  }
};
git(["config", "user.name", "Fixture OMP"]);
git(["config", "user.email", "fixture-omp@example.test"]);
const action = process.env.OMP_FIXTURE_ACTION || "commit";
let changedPath = process.env.OMP_FIXTURE_CHANGED_PATH || "issue-owned.txt";
if (action === "retry") changedPath = "issue-owned-retry.txt";
if (action === "apple") changedPath = "apps/ios/Unauthorized.swift";
if (action === "generated") changedPath = "gen/ts/src/unauthorized.ts";
if (action === "conflict_change") changedPath = "base.txt";
if (action === "dependency") changedPath = "package.json";
if (action === "retry_rewrite") {
  git(["reset", "--hard", "HEAD^"]);
  changedPath = "issue-owned-rewrite.txt";
}
if (action !== "no_commit") {
  mkdirSync(dirname(changedPath), { recursive: true });
  const content = action === "dependency" ? "{\\"name\\":\\"unauthorized\\"}\\n" : action === "conflict_change" ? "agent version\\n" : "fixture change\\n";
  writeFileSync(changedPath, content);
  git(["add", changedPath]);
  git(["commit", "-m", "Implement fixture issue"]);
}
if (process.env.OMP_FIXTURE_REMOVE_COMMAND) {
  writeFileSync(process.env.OMP_FIXTURE_REMOVE_COMMAND, "#!/definitely/missing\\n");
}
if (action === "merge") {
  git(["checkout", "-b", "fixture-side", "HEAD^"]);
  writeFileSync("side.txt", "side\\n");
  git(["add", "side.txt"]);
  git(["commit", "-m", "Fixture side"]);
  git(["checkout", "agent/issue-88"]);
  git(["merge", "--no-ff", "fixture-side", "-m", "Fixture merge"]);
}
if (process.env.OMP_FIXTURE_MUTATE_ISSUE === "1") {
  const state = JSON.parse(readFileSync(process.env.GH_FIXTURE_STATE, "utf8"));
  state.issue.body += "\\nTrusted mid-run mutation.\\n";
  writeFileSync(process.env.GH_FIXTURE_STATE, JSON.stringify(state, null, 2) + "\\n");
}
if (process.env.OMP_FIXTURE_ADVANCE_MAIN) {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
  const mainClone = mkdtempSync(join(tmpdir(), "nama-main-advance-"));
  const clone = spawnSync("git", ["clone", "--branch", "main", remote, mainClone], { encoding: "utf8" });
  if (clone.status !== 0) {
    process.stderr.write(clone.stderr || clone.stdout);
    process.exit(clone.status || 93);
  }
  const mainGit = mainArgs => {
    const result = spawnSync("git", mainArgs, { cwd: mainClone, encoding: "utf8" });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      process.exit(result.status || 94);
    }
  };
  mainGit(["config", "user.name", "Fixture Main"]);
  mainGit(["config", "user.email", "fixture-main@example.test"]);
  const mainPath = process.env.OMP_FIXTURE_ADVANCE_MAIN === "conflict" ? "base.txt" : "main-advanced.txt";
  writeFileSync(join(mainClone, mainPath), process.env.OMP_FIXTURE_ADVANCE_MAIN === "conflict" ? "main version\\n" : "main advance\\n");
  mainGit(["add", mainPath]);
  mainGit(["commit", "-m", "Advance fixture main"]);
  mainGit(["push", "origin", "main"]);
}
const fixtures = JSON.parse(readFileSync(process.env.OMP_PROTOCOL_FIXTURES, "utf8"));
const scenario = process.env.OMP_FIXTURE_SCENARIO || "complete";
if (scenario === "idle") {
  setInterval(() => {}, 1_000);
} else {
  for (const event of fixtures[scenario]) {
    process.stdout.write((typeof event === "string" ? event : JSON.stringify(event)) + "\\n");
  }
}
`,
  );
  await writeExecutable(
    join(bin, "mise"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MISE_FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(Number(process.env.MISE_FIXTURE_EXIT || "0"));
`,
  );

  await writeExecutable(
    join(bin, "xcodebuild"),
    '#!/usr/bin/env node\nprocess.stdout.write("Xcode 26.1\\nBuild version 17B1\\n");\n',
  );
  await writeExecutable(
    join(bin, "xcrun"),
    '#!/usr/bin/env node\nprocess.stdout.write("26.1\\n");\n',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SSH_AUTH_SOCK: undefined,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    GH_FIXTURE_STATE: statePath,
    OMP_FIXTURE_LOG: ompLogPath,
    OMP_PROTOCOL_FIXTURES: join(sourceRoot, "tools/agent-issue/fixtures/omp-v18.0.6.json"),
    MISE_FIXTURE_LOG: miseLogPath,
  };
  return {
    root,
    repo,
    origin,
    bin,
    statePath,
    ompLogPath,
    miseLogPath,
    env,
    async readState() {
      return JSON.parse(await readFile(statePath, "utf8")) as FixtureState;
    },
    async writeState(state) {
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    },
    async run(args, extraEnv = {}) {
      return await exec(process.execPath, [cliPath, ...args], repo, { ...env, ...extraEnv });
    },
  };
}

test("dry plan is mutation-free and never invokes OMP", async () => {
  const fixture = await createFixture();
  const result = await fixture.run(["--", "88"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /PLAN issue #88/);
  assert.match(result.stdout, /agent\/issue-88/);
  assert.match(result.stdout, /openai-codex\/gpt-5\.6-sol/);
  assert.match(result.stdout, /host-user authority/);
  assert.deepEqual((await fixture.readState()).mutations, []);
  await assert.rejects(readFile(fixture.ompLogPath, "utf8"), { code: "ENOENT" });
});

test("complete execution verifies, publishes one draft, and cleans the successful worktree", async () => {
  const fixture = await createFixture();
  const result = await fixture.run(["88", "--execute"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /draft pull request/i);
  const state = await fixture.readState();
  assert.equal(state.prs.length, 1);
  assert.deepEqual(
    state.issue.labels.map((label) => label.name),
    [],
  );
  assert.deepEqual(state.issue.assignees, [{ login: "fixture-maintainer" }]);
  assert.deepEqual(state.mutations[0]?.args.slice(0, 4), ["issue", "edit", "88", "--add-assignee"]);
  assert.equal((await readFile(fixture.miseLogPath, "utf8")).trim(), '["run","check"]');

  const ompInvocation = JSON.parse((await readFile(fixture.ompLogPath, "utf8")).trim()) as {
    args: string[];
    prompt: string;
  };
  assert.deepEqual(ompInvocation.args.slice(0, 2), ["-p", "--mode"]);
  assert.ok(ompInvocation.args.includes("openai-codex/gpt-5.6-sol"));
  assert.ok(ompInvocation.args.includes("xhigh"));
  assert.ok(ompInvocation.args.includes("--no-session"));
  assert.ok(ompInvocation.args.includes("--no-prewalk"));
  assert.ok(ompInvocation.args.includes("--no-extensions"));
  assert.doesNotMatch(ompInvocation.args.join(" "), /browser|computer|task|advisor/);
  const configIndex = ompInvocation.args.indexOf("--config");
  assert.notEqual(configIndex, -1);
  const configPath = ompInvocation.args[configIndex + 1];
  assert.ok(configPath);
  const config = await readFile(configPath, "utf8");
  assert.match(config, /bash:\n  autoBackground:\n    enabled: false/);
  assert.match(config, /eval:\n  autoBackground:\n    enabled: false/);
  assert.match(ompInvocation.prompt, /Trusted clarification/);
  assert.doesNotMatch(ompInvocation.prompt, /Untrusted instruction/);

  const remoteBranch = await exec(
    "git",
    ["ls-remote", "--heads", fixture.origin, "refs/heads/agent/issue-88"],
    fixture.repo,
  );
  assert.equal(remoteBranch.code, 0);
  assert.notEqual(remoteBranch.stdout.trim(), "");
  const worktrees = await exec("git", ["worktree", "list", "--porcelain"], fixture.repo);
  assert.doesNotMatch(worktrees.stdout, /agent[./-]issue-88/);
});

test("BLOCKED and NO_CHANGE return work to humans without fabricating a pull request", async (context) => {
  for (const scenario of ["blocked", "no_change"] as const) {
    await context.test(scenario, async () => {
      const fixture = await createFixture();
      const result = await fixture.run(["88", "--execute"], {
        OMP_FIXTURE_ACTION: "no_commit",
        OMP_FIXTURE_SCENARIO: scenario,
      });

      assert.equal(result.code, 0, result.stderr);
      const state = await fixture.readState();
      assert.deepEqual(state.issue.labels, [{ name: "ready-for-human" }]);
      assert.deepEqual(state.issue.assignees, []);
      assert.equal(state.prs.length, 0);
      const mutations = JSON.stringify(state.mutations);
      assert.match(mutations, scenario === "blocked" ? /Blocked decision/ : /No change/);
      if (scenario === "no_change") {
        assert.equal((await readFile(fixture.miseLogPath, "utf8")).trim(), '["run","check"]');
      } else {
        await assert.rejects(readFile(fixture.miseLogPath, "utf8"), { code: "ENOENT" });
      }
      const worktrees = await exec("git", ["worktree", "list", "--porcelain"], fixture.repo);
      assert.match(worktrees.stdout, /agent[./-]issue-88/);
    });
  }
});

test("malformed, unknown, failed, and unterminated OMP streams fail safely before publication", async (context) => {
  for (const scenario of ["malformed", "unknown", "agent_error", "missing_terminal"] as const) {
    await context.test(scenario, async () => {
      const fixture = await createFixture();
      const result = await fixture.run(["88", "--execute"], {
        OMP_FIXTURE_ACTION: "no_commit",
        OMP_FIXTURE_SCENARIO: scenario,
      });

      assert.equal(result.code, 1);
      const state = await fixture.readState();
      assert.equal(state.prs.length, 0);
      assert.deepEqual(state.issue.labels, [{ name: "ready-for-agent" }]);
      assert.deepEqual(state.issue.assignees, []);
      const publishedDiagnostics = JSON.stringify(state.mutations);
      assert.match(publishedDiagnostics, /Local recovery state was retained/);
      assert.doesNotMatch(
        publishedDiagnostics,
        /not-json|future_unrecognized_event|sanitized provider failure/,
      );
    });
  }
});

test("conflicting terminal claims fail before host verification or publication", async () => {
  const fixture = await createFixture();
  const result = await fixture.run(["88", "--execute"], {
    OMP_FIXTURE_SCENARIO: "conflicting_terminal",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /TERMINAL_CLAIM_MULTIPLE/);
  const state = await fixture.readState();
  assert.equal(state.prs.length, 0);
  assert.deepEqual(state.issue.assignees, []);
  await assert.rejects(readFile(fixture.miseLogPath, "utf8"), { code: "ENOENT" });
});

test("COMPLETE rejects invalid commit and boundary states before the host check", async (context) => {
  const cases: Array<{ action: string; code: RegExp }> = [
    { action: "no_commit", code: /COMPLETE_WITHOUT_COMMIT/ },
    { action: "merge", code: /MERGE_COMMIT_REJECTED/ },
    { action: "apple", code: /XCODE_LABEL_MISSING/ },
    { action: "generated", code: /GENERATED_OWNER_MISSING/ },
    { action: "dependency", code: /DEPENDENCY_CHANGE_UNAUTHORIZED/ },
  ];
  for (const fixtureCase of cases) {
    await context.test(fixtureCase.action, async () => {
      const fixture = await createFixture();
      const result = await fixture.run(["88", "--execute"], {
        OMP_FIXTURE_ACTION: fixtureCase.action,
        OMP_FIXTURE_SCENARIO: "complete",
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, fixtureCase.code);
      const state = await fixture.readState();
      assert.equal(state.prs.length, 0);
      if (fixtureCase.action === "apple") {
        assert.deepEqual(state.issue.labels, [{ name: "ready-for-human" }]);
      }
      await assert.rejects(readFile(fixture.miseLogPath, "utf8"), { code: "ENOENT" });
    });
  }
});

test("boundary changes require positive issue authorization", async (context) => {
  await context.test("negative dependency instruction", async () => {
    const fixture = await createFixture({
      body: "## Acceptance criteria\n\n- No package or dependency changes are authorized.\n",
    });
    const result = await fixture.run(["88", "--execute"], {
      OMP_FIXTURE_ACTION: "dependency",
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /DEPENDENCY_CHANGE_UNAUTHORIZED/);
    assert.equal((await fixture.readState()).prs.length, 0);
  });

  for (const body of [
    "## Acceptance criteria\n\n- Document the dependency change policy.\n",
    "## Acceptance criteria\n\n- A dependency change is out of scope.\n",
  ]) {
    await context.test(body, async () => {
      const fixture = await createFixture({ body });
      const result = await fixture.run(["88", "--execute"], {
        OMP_FIXTURE_ACTION: "dependency",
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /DEPENDENCY_CHANGE_UNAUTHORIZED/);
      assert.equal((await fixture.readState()).prs.length, 0);
    });
  }

  await context.test("positive dependency instruction", async () => {
    const fixture = await createFixture({
      body: "## Acceptance criteria\n\n- Update the root package dependency for this issue.\n",
    });
    const result = await fixture.run(["88", "--execute"], {
      OMP_FIXTURE_ACTION: "dependency",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fixture.readState()).prs.length, 1);
  });
});

test("every native dependency manifest requires explicit authorization", async (context) => {
  const dependencyPaths: Array<{ path: string; requiresXcode?: true }> = [
    { path: "pnpm-workspace.yaml" },
    { path: "buf.yaml" },
    { path: "buf.lock" },
    { path: "apps/server/package.json" },
    { path: "plugins/jellyfin/package.json" },
    { path: "gen/ts/package.json" },
    { path: "gen/swift/Package.swift", requiresXcode: true },
    { path: "apps/ios/Nama.xcodeproj/project.pbxproj", requiresXcode: true },
    {
      path: "apps/ios/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      requiresXcode: true,
    },
  ];

  for (const dependencyPath of dependencyPaths) {
    await context.test(dependencyPath.path, async () => {
      const labels = [{ name: "ready-for-agent" }];
      const args = ["88", "--execute"];
      if (dependencyPath.requiresXcode) {
        labels.push({ name: "requires:xcode" });
        args.push("--capability", "xcode");
      }
      const fixture = await createFixture({
        body: "## Acceptance criteria\n\n- No dependency changes are authorized.\n",
        labels,
      });
      const result = await fixture.run(args, {
        OMP_FIXTURE_CHANGED_PATH: dependencyPath.path,
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /DEPENDENCY_CHANGE_UNAUTHORIZED/);
      assert.equal((await fixture.readState()).prs.length, 0);
    });
  }
});

test("Apple-owned tooling requires the pre-triaged Xcode capability", async (context) => {
  for (const path of [
    "scripts/check-ios.sh",
    "scripts/check-swift.sh",
    ".swiftlint.yml",
    ".swiftlint-analyze.yml",
  ]) {
    await context.test(path, async () => {
      const fixture = await createFixture();
      const result = await fixture.run(["88", "--execute"], {
        OMP_FIXTURE_CHANGED_PATH: path,
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /XCODE_LABEL_MISSING/);
      assert.deepEqual((await fixture.readState()).issue.labels, [{ name: "ready-for-human" }]);
      await assert.rejects(readFile(fixture.miseLogPath, "utf8"), { code: "ENOENT" });
    });
  }
});

test("host-check failure and meaningful issue mutation preserve recovery state and publish nothing", async (context) => {
  await context.test("host check", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], { MISE_FIXTURE_EXIT: "9" });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /HOST_CHECK_FAILED/);
    const state = await fixture.readState();
    assert.equal(state.prs.length, 0);
    assert.deepEqual(state.issue.assignees, []);
    assert.deepEqual(state.issue.labels, [{ name: "ready-for-agent" }]);
  });

  await context.test("issue mutation", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], { OMP_FIXTURE_MUTATE_ISSUE: "1" });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ISSUE_CHANGED/);
    assert.equal((await fixture.readState()).prs.length, 0);
  });
});

test("a missing post-claim command fails safely and releases assignment and lock", async () => {
  const fixture = await createFixture();
  const result = await fixture.run(["88", "--execute"], {
    OMP_FIXTURE_REMOVE_COMMAND: join(fixture.bin, "mise"),
    PATH: `${fixture.bin}:/usr/bin:/bin`,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /COMMAND_SPAWN_FAILED/);
  const state = await fixture.readState();
  assert.equal(state.prs.length, 0);
  assert.deepEqual(state.issue.assignees, []);
  await assert.rejects(readFile(join(fixture.repo, ".git/nama-agent/active-run.json"), "utf8"), {
    code: "ENOENT",
  });
});

test("execution preflight rejects wrong OMP, sensitive environment, and a concurrent run before claiming", async (context) => {
  await context.test("wrong OMP", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], { OMP_FIXTURE_VERSION: "18.0.7" });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /OMP_VERSION_MISMATCH/);
    assert.deepEqual((await fixture.readState()).mutations, []);
    await assert.rejects(readFile(fixture.ompLogPath, "utf8"), { code: "ENOENT" });
  });

  await context.test("sensitive environment", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], { OPENAI_API_KEY: "must-not-pass" });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /SENSITIVE_ENVIRONMENT.*OPENAI_API_KEY/);
    assert.deepEqual((await fixture.readState()).mutations, []);
    await assert.rejects(readFile(fixture.ompLogPath, "utf8"), { code: "ENOENT" });
  });

  await context.test("concurrent lock", async () => {
    const fixture = await createFixture();
    const lockDirectory = join(fixture.repo, ".git/nama-agent");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      join(lockDirectory, "active-run.json"),
      `${JSON.stringify({ version: 1, runId: "other-run", issueNumber: 99, pid: process.pid })}\n`,
      "utf8",
    );
    const result = await fixture.run(["88", "--execute"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /CONCURRENT_RUN/);
    assert.deepEqual((await fixture.readState()).mutations, []);
    await assert.rejects(readFile(fixture.ompLogPath, "utf8"), { code: "ENOENT" });
  });
});

test("admission rejects unsafe issue state and enforces Xcode capability metadata", async (context) => {
  const rejected: Array<{ name: string; overrides: Partial<FixtureIssue>; code: RegExp }> = [
    { name: "closed", overrides: { state: "closed" }, code: /ISSUE_CLOSED/ },
    { name: "unready", overrides: { labels: [] }, code: /ISSUE_NOT_READY/ },
    {
      name: "assigned",
      overrides: { assignees: [{ login: "someone-else" }] },
      code: /ISSUE_ASSIGNED/,
    },
    {
      name: "capability mismatch",
      overrides: { labels: [{ name: "ready-for-agent" }, { name: "requires:xcode" }] },
      code: /CAPABILITY_MISMATCH/,
    },
  ];
  for (const rejectedCase of rejected) {
    await context.test(rejectedCase.name, async () => {
      const fixture = await createFixture(rejectedCase.overrides);
      const result = await fixture.run(["88", "--execute"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, rejectedCase.code);
      assert.deepEqual((await fixture.readState()).mutations, []);
      await assert.rejects(readFile(fixture.ompLogPath, "utf8"), { code: "ENOENT" });
    });
  }

  await context.test("verified Xcode runner", async () => {
    const fixture = await createFixture({
      labels: [{ name: "ready-for-agent" }, { name: "requires:xcode" }],
    });
    const result = await fixture.run(["88", "--capability", "xcode"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /xcode \(verified\)/);
  });

  await context.test("unusable Xcode runner", async () => {
    const fixture = await createFixture({
      labels: [{ name: "ready-for-agent" }, { name: "requires:xcode" }],
    });
    await writeExecutable(
      join(fixture.bin, "xcodebuild"),
      '#!/usr/bin/env node\nprocess.stdout.write("Xcode 25.4\\nBuild version 16F1\\n");\n',
    );
    const result = await fixture.run(["88", "--capability", "xcode"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /XCODE_UNUSABLE/);
    assert.deepEqual((await fixture.readState()).mutations, []);
  });
});

test("admission blocks only open native dependencies", async (context) => {
  await context.test("closed historical dependencies", async () => {
    const fixture = await createFixture({
      issue_dependencies_summary: { blocked_by: 2 },
    });
    const state = await fixture.readState();
    state.blockers = [
      { number: 177, title: "Closed dependency", state: "closed" },
      { number: 179, title: "Another closed dependency", state: "CLOSED" },
    ];
    await fixture.writeState(state);

    const result = await fixture.run(["88"]);
    assert.equal(result.code, 0, result.stderr);
  });

  await context.test("open dependency", async () => {
    const fixture = await createFixture({
      issue_dependencies_summary: { blocked_by: 1 },
    });
    const state = await fixture.readState();
    state.blockers = [{ number: 180, title: "Open dependency", state: "open" }];
    await fixture.writeState(state);

    const result = await fixture.run(["88"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ISSUE_BLOCKED/);
  });
});

test("normal reruns reject retained work while an explicit retry starts a fresh OMP session", async () => {
  const fixture = await createFixture();
  const first = await fixture.run(["88", "--execute"], { MISE_FIXTURE_EXIT: "9" });
  assert.equal(first.code, 1);
  const firstState = await fixture.readState();
  const mutationText = JSON.stringify(firstState.mutations);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/.exec(mutationText)?.[0];
  assert.ok(runId);

  const normalRerun = await fixture.run(["88", "--execute"]);
  assert.equal(normalRerun.code, 1);
  assert.match(normalRerun.stderr, /BRANCH_EXISTS/);

  const retry = await fixture.run(["88", "--execute", "--retry", runId], {
    MISE_FIXTURE_EXIT: "0",
    OMP_FIXTURE_ACTION: "retry",
  });
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal((await fixture.readState()).prs.length, 1);
  assert.equal((await readFile(fixture.ompLogPath, "utf8")).trim().split("\n").length, 2);
});

test("stale-lock recovery requires matching dead-process evidence and cleanup verifies metadata", async (context) => {
  await context.test("stale lock", async () => {
    const fixture = await createFixture();
    const stateDirectory = join(fixture.repo, ".git/nama-agent");
    const runId = "issue-88-stale-deadbeef";
    await mkdir(join(stateDirectory, "runs", runId), { recursive: true });
    const runDirectory = join(stateDirectory, "runs", runId);
    await writeFile(
      join(runDirectory, "metadata.json"),
      `${JSON.stringify({ version: 1, runId, issueNumber: 88, repository: "electather/nama", branch: "agent/issue-88", baseSha: "0".repeat(40), startedAt: "2026-08-01T00:00:00Z", pid: 999_999, status: "running", runDirectory })}\n`,
      "utf8",
    );
    await writeFile(
      join(stateDirectory, "active-run.json"),
      `${JSON.stringify({ version: 1, runId, issueNumber: 88, branch: "agent/issue-88", baseSha: "0".repeat(40), pid: 999_999, startedAt: "2026-08-01T00:00:00Z" })}\n`,
      "utf8",
    );
    const assignedState = await fixture.readState();
    assignedState.issue.assignees = [{ login: assignedState.login }];
    await fixture.writeState(assignedState);
    const recovered = await fixture.run(["88", "--recover-stale-lock", runId]);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, /Recovered stale lock/);
    assert.deepEqual((await fixture.readState()).issue.assignees, []);
    const recoveredMetadata = JSON.parse(
      await readFile(join(runDirectory, "metadata.json"), "utf8"),
    ) as { status: string; failureStage?: string; failureCode?: string };
    assert.deepEqual(recoveredMetadata, {
      version: 1,
      runId,
      issueNumber: 88,
      repository: "electather/nama",
      branch: "agent/issue-88",
      baseSha: "0".repeat(40),
      startedAt: "2026-08-01T00:00:00Z",
      pid: 999_999,
      status: "failed",
      runDirectory,
      failureStage: "recovery",
      failureCode: "STALE_LOCK_RECOVERED",
    });
    await assert.rejects(readFile(join(stateDirectory, "active-run.json"), "utf8"), {
      code: "ENOENT",
    });
  });

  await context.test("live lock", async () => {
    const fixture = await createFixture();
    const stateDirectory = join(fixture.repo, ".git/nama-agent");
    const runId = "issue-88-live-deadbeef";
    await mkdir(join(stateDirectory, "runs", runId), { recursive: true });
    const runDirectory = join(stateDirectory, "runs", runId);
    await writeFile(
      join(runDirectory, "metadata.json"),
      `${JSON.stringify({ version: 1, runId, issueNumber: 88, repository: "electather/nama", branch: "agent/issue-88", baseSha: "0".repeat(40), startedAt: "2026-08-01T00:00:00Z", pid: process.pid, status: "failed", runDirectory })}\n`,
      "utf8",
    );
    await writeFile(
      join(stateDirectory, "active-run.json"),
      `${JSON.stringify({ version: 1, runId, issueNumber: 88, branch: "agent/issue-88", baseSha: "0".repeat(40), pid: process.pid, startedAt: "2026-08-01T00:00:00Z" })}\n`,
      "utf8",
    );
    const recovered = await fixture.run(["88", "--recover-stale-lock", runId]);
    assert.equal(recovered.code, 1);
    assert.match(recovered.stderr, /LOCK_PROCESS_ALIVE/);
  });

  await context.test("metadata-verified cleanup", async () => {
    const fixture = await createFixture();
    const failed = await fixture.run(["88", "--execute"], { MISE_FIXTURE_EXIT: "9" });
    assert.equal(failed.code, 1);
    const runId = /issue-88-[0-9]+-[0-9a-f]+/.exec(
      JSON.stringify((await fixture.readState()).mutations),
    )?.[0];
    assert.ok(runId);
    const cleaned = await fixture.run(["88", "--cleanup", runId]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    const worktrees = await exec("git", ["worktree", "list", "--porcelain"], fixture.repo);
    assert.doesNotMatch(worktrees.stdout, /agent[./-]issue-88/);
  });
});

test("cleanup retains local recovery state when the remote probe fails", async () => {
  const fixture = await createFixture();
  const failed = await fixture.run(["88", "--execute"], { MISE_FIXTURE_EXIT: "9" });
  assert.equal(failed.code, 1);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/u.exec(
    JSON.stringify((await fixture.readState()).mutations),
  )?.[0];
  assert.ok(runId);
  await writeExecutable(
    join(fixture.bin, "git"),
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  echo "fixture remote unavailable" >&2
  exit 73
fi
exec /usr/bin/git "$@"
`,
  );

  const cleanup = await fixture.run(["88", "--cleanup", runId]);
  assert.equal(cleanup.code, 1);
  assert.match(cleanup.stderr, /REMOTE_PROBE_FAILED/);
  const worktrees = await exec("git", ["worktree", "list", "--porcelain"], fixture.repo);
  assert.match(worktrees.stdout, /agent[./-]issue-88/);
});

test("recovery rejects unknown statuses and malformed optional metadata fields", async (context) => {
  const fixture = await createFixture();
  const stateDirectory = join(fixture.repo, ".git/nama-agent");
  const runId = "issue-88-invalid-deadbeef";
  const runDirectory = join(stateDirectory, "runs", runId);
  const metadataPath = join(runDirectory, "metadata.json");
  await mkdir(runDirectory, { recursive: true });
  const validMetadata: Record<string, unknown> = {
    version: 1,
    runId,
    issueNumber: 88,
    repository: "electather/nama",
    branch: "agent/issue-88",
    baseSha: "0".repeat(40),
    startedAt: "2026-08-01T00:00:00Z",
    pid: 999_999,
    status: "failed",
    runDirectory,
  };
  const invalidCases: Array<{ name: string; field: string; value: unknown }> = [
    { name: "unknown status", field: "status", value: "mystery" },
    { name: "worktree path", field: "worktreePath", value: 1 },
    { name: "head SHA", field: "headSha", value: false },
    { name: "remote SHA", field: "remoteSha", value: [] },
    { name: "pull request URL", field: "pullRequestUrl", value: 42 },
    { name: "failure stage", field: "failureStage", value: {} },
    { name: "failure code", field: "failureCode", value: null },
    { name: "attempt", field: "attempt", value: 1.5 },
    { name: "cleanup instant", field: "cleanedAt", value: true },
  ];

  for (const invalidCase of invalidCases) {
    await context.test(invalidCase.name, async () => {
      await writeFile(
        metadataPath,
        `${JSON.stringify({ ...validMetadata, [invalidCase.field]: invalidCase.value })}\n`,
        "utf8",
      );
      const result = await fixture.run(["88", "--cleanup", runId]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /RUN_METADATA_INVALID/);
    });
  }
});

test("advanced main publishes only when the recorded branch remains conflict-free", async (context) => {
  await context.test("conflict-free", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], { OMP_FIXTURE_ADVANCE_MAIN: "clean" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fixture.readState()).prs.length, 1);
  });

  await context.test("conflicting", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], {
      OMP_FIXTURE_ACTION: "conflict_change",
      OMP_FIXTURE_ADVANCE_MAIN: "conflict",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BASE_CONFLICT/);
    assert.equal((await fixture.readState()).prs.length, 0);
  });
});

test("ambiguous PR creation recovers idempotently by querying remote state", async () => {
  const fixture = await createFixture();
  const result = await fixture.run(["88", "--execute"], { GH_FIXTURE_AMBIGUOUS_PR: "1" });
  assert.equal(result.code, 0, result.stderr);
  const state = await fixture.readState();
  assert.equal(state.prs.length, 1);
  assert.equal(
    state.mutations.filter((mutation) => mutation.args[0] === "pr" && mutation.args[1] === "create")
      .length,
    1,
  );
});

test("publication retry resumes a confirmed matching draft without rerunning OMP", async () => {
  const fixture = await createFixture();
  const first = await fixture.run(["88", "--execute"], {
    GH_FIXTURE_FINALIZE_FAIL: "1",
  });
  assert.equal(first.code, 1);
  const failedState = await fixture.readState();
  assert.equal(failedState.prs.length, 1);
  assert.deepEqual(failedState.issue.labels, [{ name: "ready-for-agent" }]);
  assert.deepEqual(failedState.issue.assignees, []);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/u.exec(JSON.stringify(failedState.mutations))?.[0];
  assert.ok(runId);

  const retry = await fixture.run(["88", "--execute", "--retry", runId]);
  assert.equal(retry.code, 0, retry.stderr);
  const recoveredState = await fixture.readState();
  assert.equal(recoveredState.prs.length, 1);
  assert.deepEqual(recoveredState.issue.labels, []);
  assert.deepEqual(recoveredState.issue.assignees, [{ login: "fixture-maintainer" }]);
  assert.equal((await readFile(fixture.ompLogPath, "utf8")).trim().split("\n").length, 1);
  const worktrees = await exec("git", ["worktree", "list", "--porcelain"], fixture.repo);
  assert.doesNotMatch(worktrees.stdout, /agent[./-]issue-88/);
});

test("publication retry recovers a matching draft after ambiguous confirmation", async () => {
  const fixture = await createFixture();
  const first = await fixture.run(["88", "--execute"], {
    GH_FIXTURE_PR_QUERY_FAIL_AFTER_CREATE: "1",
  });
  assert.equal(first.code, 1);
  const failedState = await fixture.readState();
  assert.equal(failedState.prs.length, 1);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/u.exec(JSON.stringify(failedState.mutations))?.[0];
  assert.ok(runId);

  const retry = await fixture.run(["88", "--execute", "--retry", runId]);
  assert.equal(retry.code, 0, retry.stderr);
  const recoveredState = await fixture.readState();
  assert.equal(recoveredState.prs.length, 1);
  assert.deepEqual(recoveredState.issue.labels, []);
  assert.deepEqual(recoveredState.issue.assignees, [{ login: "fixture-maintainer" }]);
  assert.equal((await readFile(fixture.ompLogPath, "utf8")).trim().split("\n").length, 1);
});

test("explicit publication retry uses recorded force-with-lease when history diverged", async () => {
  const fixture = await createFixture();
  const first = await fixture.run(["88", "--execute"], { GH_FIXTURE_PR_FAIL: "1" });
  assert.equal(first.code, 1);
  assert.match(first.stderr, /PULL_REQUEST_UNCONFIRMED/);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/.exec(
    JSON.stringify((await fixture.readState()).mutations),
  )?.[0];
  assert.ok(runId);

  const retry = await fixture.run(["88", "--execute", "--retry", runId], {
    OMP_FIXTURE_ACTION: "retry_rewrite",
  });
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal((await fixture.readState()).prs.length, 1);
  const hostLog = await readFile(
    join(fixture.repo, ".git/nama-agent/runs", runId, "host.jsonl"),
    "utf8",
  );
  assert.match(hostLog, /publication\.force_with_lease/);
  assert.doesNotMatch(hostLog, /"--force"/);
});

test("ambiguous branch push recovers by confirming the deterministic remote SHA", async () => {
  const fixture = await createFixture();
  await writeExecutable(
    join(fixture.bin, "git"),
    `#!/bin/sh
if [ "$1" = "push" ] && [ "$GIT_FIXTURE_AMBIGUOUS_PUSH" = "1" ]; then
  /usr/bin/git "$@" || exit $?
  exit 97
fi
exec /usr/bin/git "$@"
`,
  );
  const result = await fixture.run(["88", "--execute"], { GIT_FIXTURE_AMBIGUOUS_PUSH: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await fixture.readState()).prs.length, 1);
});

test("idle timeout and operator interruption terminate OMP while retaining recoverable work", async (context) => {
  await context.test("idle timeout", async () => {
    const fixture = await createFixture();
    const result = await fixture.run(["88", "--execute"], {
      NAMA_AGENT_TEST_MODE: "1",
      NAMA_AGENT_TEST_IDLE_TIMEOUT_SECONDS: "0.1",
      OMP_FIXTURE_SCENARIO: "idle",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /idle/i);
    assert.equal((await fixture.readState()).prs.length, 0);
  });

  await context.test("SIGINT", async () => {
    const fixture = await createFixture();
    const child = spawn(process.execPath, [cliPath, "88", "--execute"], {
      cwd: fixture.repo,
      env: { ...fixture.env, OMP_FIXTURE_SCENARIO: "idle" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const changes = watch(fixture.root);
    try {
      await readFile(fixture.ompLogPath, "utf8");
    } catch {
      for await (const change of changes) {
        if (change.filename === "omp.log") {
          break;
        }
      }
    }
    await changes.return?.();
    child.kill("SIGINT");
    const { promise, resolve: resolveExit } = Promise.withResolvers<number | null>();
    // TypeScript 7 loses ChildProcess's EventEmitter base on this spawn overload.
    const eventfulChild = child as ChildProcess;
    eventfulChild.addListener("close", resolveExit);
    const exitCode = await promise;
    assert.equal(exitCode, 1, stderr);
    assert.match(stderr, /INTERRUPTED|Operator interrupted/);
    const state = await fixture.readState();
    assert.equal(state.prs.length, 0);
    assert.deepEqual(state.issue.assignees, []);
  });
});

void test("admission rejects existing implementation branches and pull requests", async (context) => {
  await context.test("local branch", async () => {
    const fixture = await createFixture();
    assert.equal((await exec("git", ["branch", "agent/issue-88"], fixture.repo)).code, 0);
    const result = await fixture.run(["88"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BRANCH_EXISTS/);
  });

  await context.test("remote branch", async () => {
    const fixture = await createFixture();
    assert.equal(
      (await exec("git", ["push", fixture.origin, "main:refs/heads/agent/issue-88"], fixture.repo))
        .code,
      0,
    );
    const result = await fixture.run(["88"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /BRANCH_EXISTS/);
  });

  await context.test("matching pull request", async () => {
    const fixture = await createFixture();
    const state = await fixture.readState();
    state.prs.push({
      body: "Closes #88",
      headRefName: "someone/implementation",
      number: 42,
      url: "https://example.test/pr/42",
    });
    await fixture.writeState(state);
    const result = await fixture.run(["88"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PULL_REQUEST_EXISTS/);
  });
});

void test("retry rejects a recorded base that is not an ancestor of preserved work", async () => {
  const fixture = await createFixture();
  const failed = await fixture.run(["88", "--execute"], { MISE_FIXTURE_EXIT: "9" });
  assert.equal(failed.code, 1);
  const runId = /issue-88-[0-9]+-[0-9a-f]+/u.exec(
    JSON.stringify((await fixture.readState()).mutations),
  )?.[0];
  assert.ok(runId);
  const metadataPath = join(fixture.repo, ".git/nama-agent/runs", runId, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { baseSha: string };
  metadata.baseSha = "0".repeat(40);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const retry = await fixture.run(["88", "--execute", "--retry", runId]);
  assert.equal(retry.code, 1);
  assert.match(retry.stderr, /RETRY_STALE_BASE/);
  assert.deepEqual((await fixture.readState()).issue.assignees, []);
});
