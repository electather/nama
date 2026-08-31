import assert from "node:assert/strict";
import test from "node:test";

import {
  compareReports,
  createReport,
  normalizeGoEvents,
  normalizeXcodeResult,
  normalizeVitestRecords,
  runIdentityFromEnvironment,
  summarizeReport,
} from "./test-health.mjs";

const RUN = Object.freeze({
  identity: "run-42",
  iteration: 2,
  revision: "0123456789abcdef",
});
test("normalizes Vitest diagnostics and retry state", () => {
  const report = normalizeVitestRecords(
    [
      {
        duration: 42,
        file: "src/http/tests/health.test.ts",
        flaky: true,
        heap: 2048,
        project: "parallel",
        repeatCount: 1,
        retryCount: 1,
        slow: true,
        state: "passed",
        test: "serves liveness",
      },
    ],
    { run: RUN, shuffleSeed: 44 },
  );

  assert.deepEqual(report.tests, [
    {
      durationMs: 42,
      flaky: true,
      heapBytes: 2048,
      metrics: [],
      repeatCount: 1,
      retryCount: 1,
      shuffleSeed: 44,
      slow: true,
      status: "passed",
      suite: "parallel:src/http/tests/health.test.ts",
      test: "serves liveness",
    },
  ]);
});

test("normalizes Go package and test timing without retaining output", () => {
  const events = [
    { Action: "run", Package: "example.test/pkg", Test: "TestFast" },
    {
      Action: "output",
      Output: "password=forbidden-secret locator=https://provider.invalid/media",
      Package: "example.test/pkg",
      Test: "TestFast",
    },
    { Action: "pass", Elapsed: 0.125, Package: "example.test/pkg", Test: "TestFast" },
    { Action: "pass", Elapsed: 0.5, Package: "example.test/pkg" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  const report = normalizeGoEvents(events, {
    run: RUN,
    shuffleSeed: 9182,
  });

  assert.deepEqual(report.tests, [
    {
      durationMs: 500,
      flaky: false,
      heapBytes: null,
      metrics: [],
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed: 9182,
      slow: null,
      status: "passed",
      suite: "example.test/pkg",
      test: "(package)",
    },
    {
      durationMs: 125,
      flaky: false,
      heapBytes: null,
      metrics: [],
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed: 9182,
      slow: null,
      status: "passed",
      suite: "example.test/pkg",
      test: "TestFast",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /forbidden-secret|provider\.invalid/);
});

test("normalizes Xcode test durations and available performance metrics", () => {
  const result = {
    testNodes: [
      {
        children: [
          {
            children: [
              {
                duration: "1.25s",
                metrics: [
                  {
                    displayName: "Clock Monotonic Time",
                    unitOfMeasurement: "s",
                    value: 0.75,
                  },
                ],
                name: "loads catalog",
                nodeType: "Test Case",
                result: "Passed",
              },
              {
                duration: "0.50s",
                failureSummaries: [{ message: "token=forbidden-secret" }],
                name: "rejects stale credentials",
                nodeType: "Test Case",
                result: "Failed",
              },
            ],
            name: "NamaTests",
            nodeType: "Test Suite",
          },
        ],
        name: "Nama",
        nodeType: "Test Plan",
      },
    ],
  };

  const report = normalizeXcodeResult(result, { run: RUN });

  assert.deepEqual(report.tests, [
    {
      durationMs: 1250,
      flaky: false,
      heapBytes: null,
      metrics: [
        {
          name: "Clock Monotonic Time",
          unit: "s",
          value: 0.75,
        },
      ],
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed: null,
      slow: null,
      status: "passed",
      suite: "Nama > NamaTests",
      test: "loads catalog",
    },
    {
      durationMs: 500,
      flaky: false,
      heapBytes: null,
      metrics: [],
      repeatCount: 0,
      retryCount: 0,
      shuffleSeed: null,
      slow: null,
      status: "failed",
      suite: "Nama > NamaTests",
      test: "rejects stale credentials",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /forbidden-secret/);
  const summary = summarizeReport(report);
  assert.match(summary, /### Performance metrics/);
  assert.match(summary, /Clock Monotonic Time/);
  assert.match(summary, /0\.75/);
});

test("bounds report identities and summarizes slow tests deterministically", () => {
  const report = createReport({
    owner: "typescript",
    run: RUN,
    tests: [
      {
        durationMs: 200,
        flaky: false,
        heapBytes: null,
        metrics: [],
        repeatCount: 0,
        retryCount: 0,
        shuffleSeed: null,
        slow: true,
        status: "failed",
        suite: "parallel:b.test.ts",
        test: "second",
      },
      {
        durationMs: 200,
        flaky: true,
        heapBytes: 1024,
        metrics: [],
        repeatCount: 1,
        retryCount: 1,
        shuffleSeed: null,
        slow: true,
        status: "passed",
        suite: "parallel:a.test.ts",
        test: "a".repeat(800),
      },
    ],
  });
  const summary = summarizeReport(report);

  assert.equal(report.tests[0].test.length, 512);
  const slowest = summary.slice(summary.indexOf("### Slowest tests"));
  assert.ok(slowest.indexOf("parallel:a.test.ts") < slowest.indexOf("parallel:b.test.ts"));
  assert.match(summary, /Retries or repeats: 1/);
  assert.match(summary, /Flaky results: 1/);
  assert.match(summary, /Heap bytes/);
  assert.match(summary, /### Failures/);
});

test("preserves bounded omissions while enriching a report", () => {
  const tests = Array.from({ length: 20_001 }, (_, index) => ({
    durationMs: index,
    flaky: false,
    heapBytes: null,
    metrics: [],
    repeatCount: 0,
    retryCount: 0,
    shuffleSeed: null,
    slow: false,
    status: "passed",
    suite: "parallel:bounded.test.ts",
    test: `record-${index}`,
  }));
  const bounded = createReport({ owner: "typescript", run: RUN, tests });
  const enriched = createReport({
    ...bounded,
    resources: [
      {
        cpuSystemSeconds: 1,
        cpuUserSeconds: 2,
        peakRssBytes: 3,
        scope: "worker",
      },
    ],
  });

  assert.equal(bounded.omittedTestCount, 1);
  assert.equal(enriched.omittedTestCount, 1);
});

test("rejects malformed and unsafe run metadata integers", () => {
  const previous = process.env["NAMA_TEST_ITERATION"];
  try {
    process.env["NAMA_TEST_ITERATION"] = "invalid";
    assert.throws(runIdentityFromEnvironment, /NAMA_TEST_ITERATION must be a safe integer/);
    process.env["NAMA_TEST_ITERATION"] = "9007199254740992";
    assert.throws(runIdentityFromEnvironment, /NAMA_TEST_ITERATION must be a safe integer/);
  } finally {
    if (previous === undefined) {
      delete process.env["NAMA_TEST_ITERATION"];
    } else {
      process.env["NAMA_TEST_ITERATION"] = previous;
    }
  }
});

test("rejects inconsistent repeated health outcomes", () => {
  const passing = createReport({
    owner: "swift",
    run: { ...RUN, iteration: 1 },
    tests: [
      {
        durationMs: 10,
        flaky: false,
        heapBytes: null,
        metrics: [],
        repeatCount: 0,
        retryCount: 0,
        shuffleSeed: null,
        slow: null,
        status: "passed",
        suite: "NamaTests",
        test: "loads catalog",
      },
    ],
  });
  const failing = structuredClone(passing);
  failing.run.iteration = 2;
  failing.tests[0].status = "failed";

  assert.throws(() => compareReports([passing, failing]), /inconsistent outcome/);
  assert.doesNotThrow(() =>
    compareReports([passing, structuredClone(passing), structuredClone(passing)]),
  );
});
