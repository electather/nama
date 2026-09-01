import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_IDENTITY_LENGTH = 512;
const MAX_TEST_RECORDS = 20_000;
const REPORT_VERSION = 1;
const MAX_FAILURE_RECORDS = 50;
const MAX_METRIC_RECORDS = 50;
const TOP_TEST_COUNT = 10;

const boundedIdentity = (value) =>
  String(value ?? "unknown")
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, MAX_IDENTITY_LENGTH);

const finiteNumber = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const integerEnvironmentValue = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
};

const normalizedStatus = (value) => {
  const status = String(value).toLowerCase();
  if (status === "pass" || status === "passed" || status === "success") {
    return "passed";
  }
  if (status === "fail" || status === "failed" || status === "failure") {
    return "failed";
  }
  return "skipped";
};

const normalizedTest = (test) => ({
  durationMs: Math.max(0, finiteNumber(test.durationMs)),
  flaky: test.flaky === true,
  heapBytes: test.heapBytes === null ? null : Math.max(0, finiteNumber(test.heapBytes)),
  metrics: Array.isArray(test.metrics)
    ? test.metrics.slice(0, 32).map((metric) => ({
        name: boundedIdentity(metric.name),
        unit: boundedIdentity(metric.unit),
        value: finiteNumber(metric.value),
      }))
    : [],
  repeatCount: Math.max(0, finiteNumber(test.repeatCount)),
  retryCount: Math.max(0, finiteNumber(test.retryCount)),
  shuffleSeed: Number.isInteger(test.shuffleSeed) ? test.shuffleSeed : null,
  slow: typeof test.slow === "boolean" ? test.slow : null,
  status: normalizedStatus(test.status),
  suite: boundedIdentity(test.suite),
  test: boundedIdentity(test.test),
});

const testIdentity = (test) => `${test.suite}\u0000${test.test}`;

const compareTestIdentity = (left, right) =>
  left.suite.localeCompare(right.suite) || left.test.localeCompare(right.test);

const compareTestDuration = (left, right) =>
  right.durationMs - left.durationMs || compareTestIdentity(left, right);

const parseDurationMilliseconds = (value) => {
  if (typeof value === "number") {
    return Math.max(0, value * 1000);
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/u.exec(String(value));
  return match === null ? 0 : Number.parseFloat(match[1]) * 1000;
};

const xcodeMetrics = (node) =>
  Array.isArray(node.metrics)
    ? node.metrics
        .filter((metric) => typeof metric === "object" && metric !== null)
        .map((metric) => ({
          name: metric.displayName ?? metric.name ?? metric.identifier ?? "metric",
          unit: metric.unitOfMeasurement ?? metric.unit ?? "unknown",
          value: metric.value,
        }))
        .filter((metric) => typeof metric.value === "number" && Number.isFinite(metric.value))
    : [];

const visitXcodeNode = (node, parents, tests) => {
  if (typeof node !== "object" || node === null) {
    return;
  }
  const name = boundedIdentity(node.name ?? node.nodeIdentifier ?? "unknown");
  if (node.nodeType === "Test Case") {
    tests.push({
      durationMs: parseDurationMilliseconds(node.duration),
      flaky: false,
      heapBytes: null,
      metrics: xcodeMetrics(node),
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed: null,
      slow: null,
      status: normalizedStatus(node.result),
      suite: parents.join(" > "),
      test: name,
    });
    return;
  }
  const nextParents =
    node.nodeType === "Test Plan" || node.nodeType === "Test Suite" ? [...parents, name] : parents;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visitXcodeNode(child, nextParents, tests);
    }
  }
};

const runIdentityFromEnvironment = () => {
  const iteration = integerEnvironmentValue("NAMA_TEST_ITERATION", 1);
  if (iteration < 1) {
    throw new Error("NAMA_TEST_ITERATION must be a positive safe integer");
  }
  return {
    identity: boundedIdentity(
      process.env["NAMA_TEST_RUN_ID"] ?? process.env["GITHUB_RUN_ID"] ?? "local",
    ),
    iteration,
    revision: boundedIdentity(process.env["GITHUB_SHA"] ?? "local"),
  };
};

const shuffleSeedFromEnvironment = () => integerEnvironmentValue("NAMA_TEST_SHUFFLE_SEED", null);

const createReport = ({ omittedTestCount = 0, owner, resources = [], run, tests }) => {
  const normalizedTests = tests.map(normalizedTest).sort(compareTestIdentity);
  const retainedTests = normalizedTests.slice(0, MAX_TEST_RECORDS);
  return {
    omittedTestCount:
      Math.max(0, finiteNumber(omittedTestCount)) + normalizedTests.length - retainedTests.length,
    owner: boundedIdentity(owner),
    resources: resources.map((resource) => ({
      cpuSystemSeconds:
        resource.cpuSystemSeconds === null
          ? null
          : Math.max(0, finiteNumber(resource.cpuSystemSeconds)),
      cpuUserSeconds:
        resource.cpuUserSeconds === null
          ? null
          : Math.max(0, finiteNumber(resource.cpuUserSeconds)),
      peakRssBytes:
        resource.peakRssBytes === null ? null : Math.max(0, finiteNumber(resource.peakRssBytes)),
      scope: boundedIdentity(resource.scope),
    })),
    run: {
      identity: boundedIdentity(run.identity),
      iteration: Math.max(1, finiteNumber(run.iteration, 1)),
      revision: boundedIdentity(run.revision),
    },
    schemaVersion: REPORT_VERSION,
    tests: retainedTests,
  };
};

const normalizeVitestRecords = (records, { run, shuffleSeed = null }) =>
  createReport({
    owner: "typescript",
    run,
    tests: records.map((record) => ({
      durationMs: record.duration,
      flaky: record.flaky,
      heapBytes: record.heap ?? null,
      metrics: [],
      repeatCount: record.repeatCount,
      retryCount: record.retryCount,
      shuffleSeed,
      slow: record.slow,
      status: record.state,
      suite: `${record.project}:${record.file}`,
      test: record.test,
    })),
  });

const normalizeGoEvents = (text, { run, shuffleSeed = null }) => {
  const completed = new Map();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = JSON.parse(line);
    if (!/[Pp]ass|[Ff]ail|[Ss]kip/u.test(String(event.Action))) {
      continue;
    }
    if (typeof event.Package !== "string" || event.Package.length === 0) {
      continue;
    }
    const identity = typeof event.Test === "string" ? event.Test : "(package)";
    completed.set(`${event.Package}\u0000${identity}`, {
      durationMs: finiteNumber(event.Elapsed) * 1000,
      flaky: false,
      heapBytes: null,
      metrics: [],
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed,
      slow: null,
      status: event.Action,
      suite: event.Package,
      test: identity,
    });
  }
  return createReport({ owner: "go", run, tests: [...completed.values()] });
};

const normalizeXcodeResult = (result, { run }) => {
  const tests = [];
  if (Array.isArray(result.testNodes)) {
    for (const node of result.testNodes) {
      visitXcodeNode(node, [], tests);
    }
  }
  return createReport({ owner: "swift", run, tests });
};

const summarizeReport = (report) => {
  const failures = report.tests.filter((test) => test.status === "failed");
  const retryOrRepeat = report.tests.filter((test) => test.retryCount > 0 || test.repeatCount > 0);
  const flaky = report.tests.filter((test) => test.flaky);
  const slowest = report.tests.toSorted(compareTestDuration).slice(0, TOP_TEST_COUNT);
  const lines = [
    `## ${report.owner} test health`,
    "",
    `- Tests: ${report.tests.length}`,
    `- Failures: ${failures.length}`,
    `- Retries or repeats: ${retryOrRepeat.length}`,
    `- Flaky results: ${flaky.length}`,
    `- Omitted by report bound: ${report.omittedTestCount}`,
  ];
  if (failures.length > 0) {
    lines.push("", "### Failures", "", "| Suite | Test |", "| --- | --- |");
    for (const test of failures.slice(0, MAX_FAILURE_RECORDS)) {
      lines.push(`| ${test.suite} | ${test.test} |`);
    }
  }
  lines.push(
    "",
    "### Slowest tests",
    "",
    "| Suite | Test | Duration (ms) | Slow | Heap bytes |",
    "| --- | --- | ---: | :---: | ---: |",
  );
  for (const test of slowest) {
    lines.push(
      `| ${test.suite} | ${test.test} | ${test.durationMs.toFixed(1)} | ${test.slow ?? "unclassified"} | ${test.heapBytes ?? "unavailable"} |`,
    );
  }
  const metrics = report.tests
    .flatMap((test) =>
      test.metrics.map((metric) => ({
        ...metric,
        suite: test.suite,
        test: test.test,
      })),
    )
    .toSorted(
      (left, right) =>
        left.suite.localeCompare(right.suite) ||
        left.test.localeCompare(right.test) ||
        left.name.localeCompare(right.name),
    );
  if (metrics.length > 0) {
    lines.push(
      "",
      "### Performance metrics",
      "",
      "| Suite | Test | Metric | Value | Unit |",
      "| --- | --- | --- | ---: | --- |",
    );
    for (const metric of metrics.slice(0, MAX_METRIC_RECORDS)) {
      lines.push(
        `| ${metric.suite} | ${metric.test} | ${metric.name} | ${metric.value} | ${metric.unit} |`,
      );
    }
  }
  if (report.resources.length > 0) {
    lines.push(
      "",
      "### Worker or job resources",
      "",
      "| Scope | User CPU (s) | System CPU (s) | Peak RSS (bytes) |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const resource of report.resources) {
      lines.push(
        `| ${resource.scope} | ${resource.cpuUserSeconds ?? "unavailable"} | ${resource.cpuSystemSeconds ?? "unavailable"} | ${resource.peakRssBytes ?? "unavailable"} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

const compareReports = (reports) => {
  if (reports.length < 2) {
    throw new Error("at least two reports are required to compare health outcomes");
  }
  const baseline = reports[0];
  const baselineOutcomes = new Map(baseline.tests.map((test) => [testIdentity(test), test.status]));
  for (const report of reports.slice(1)) {
    if (report.owner !== baseline.owner) {
      throw new Error("health reports have inconsistent owners");
    }
    const outcomes = new Map(report.tests.map((test) => [testIdentity(test), test.status]));
    for (const [identity, status] of baselineOutcomes) {
      if (outcomes.get(identity) !== status) {
        throw new Error(`inconsistent outcome for ${identity.replace("\u0000", " > ")}`);
      }
    }
    for (const identity of outcomes.keys()) {
      if (!baselineOutcomes.has(identity)) {
        throw new Error(`inconsistent outcome set includes ${identity.replace("\u0000", " > ")}`);
      }
    }
  }
};

const writeReport = async (path, report) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600 });
};

const readReport = async (path) => JSON.parse(await readFile(path, "utf8"));

const publishSummary = async (report) => {
  const summary = summarizeReport(report);
  process.stdout.write(summary);
  const githubSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (githubSummary !== undefined) {
    await appendFile(githubSummary, summary, "utf8");
  }
};

const runCli = async ([command, ...paths]) => {
  if (command === "normalize-go" && paths.length === 2) {
    const report = normalizeGoEvents(await readFile(paths[0], "utf8"), {
      run: runIdentityFromEnvironment(),
      shuffleSeed: shuffleSeedFromEnvironment(),
    });
    await writeReport(paths[1], report);
    return;
  }
  if (command === "normalize-xcode" && paths.length === 2) {
    const report = normalizeXcodeResult(JSON.parse(await readFile(paths[0], "utf8")), {
      run: runIdentityFromEnvironment(),
    });
    await writeReport(paths[1], report);
    return;
  }
  if (command === "add-resource" && paths.length === 2) {
    const report = await readReport(paths[0]);
    const resource = JSON.parse(await readFile(paths[1], "utf8"));
    report.resources.push({
      cpuSystemSeconds: resource.cpuSystemSeconds ?? null,
      cpuUserSeconds: resource.cpuUserSeconds ?? null,
      peakRssBytes: resource.peakRssBytes ?? null,
      scope: resource.scope,
    });
    await writeReport(paths[0], createReport(report));
    return;
  }
  if (command === "summarize" && paths.length === 1) {
    await publishSummary(await readReport(paths[0]));
    return;
  }
  if (command === "compare" && paths.length >= 2) {
    compareReports(await Promise.all(paths.map(readReport)));
    return;
  }
  throw new Error(
    "usage: test-health.mjs normalize-go <events> <report> | normalize-xcode <result> <report> | add-resource <report> <resource> | summarize <report> | compare <report>...",
  );
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runCli(process.argv.slice(2));
}

export {
  compareReports,
  createReport,
  normalizeGoEvents,
  normalizeXcodeResult,
  normalizeVitestRecords,
  runIdentityFromEnvironment,
  shuffleSeedFromEnvironment,
  summarizeReport,
  writeReport,
};
