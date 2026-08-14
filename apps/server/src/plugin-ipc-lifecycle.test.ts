// oxlint-disable eslint/max-statements -- One disposable end-to-end assertion block mirrors the issue acceptance criteria.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Code } from "@connectrpc/connect";
import { ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

import { provePluginIpcLifecycle } from "./plugin-ipc-lifecycle.ts";

const EMPTY_COUNT = 0;
const RUNTIME_DIRECTORY_MODE = 0o700;

void test(
  "authenticated plugin subprocess restarts without durable state",
  { timeout: 10_000 },
  async () => {
    const evidence = await provePluginIpcLifecycle();

    assert.equal(evidence.runtimeDirectoryMode, RUNTIME_DIRECTORY_MODE);
    assert.equal(evidence.firstHealthStatus, ServingStatus.SERVING);
    assert.equal(evidence.secondHealthStatus, ServingStatus.SERVING);
    assert.equal(evidence.healthAfterDeadlineStatus, ServingStatus.SERVING);
    assert.equal(evidence.firstItemTitle, "IPC Lifecycle Fixture");
    assert.equal(evidence.secondItemTitle, "IPC Lifecycle Fixture");
    assert.equal(evidence.firstItemKind, MediaKind.MOVIE);
    assert.equal(evidence.secondItemKind, MediaKind.MOVIE);
    assert.equal(evidence.invalidBearerCode, Code.Unauthenticated);
    assert.equal(evidence.staleBearerCode, Code.Unauthenticated);
    assert.equal(evidence.deadlineCode, Code.DeadlineExceeded);
    assert.equal(evidence.firstExitCode, EMPTY_COUNT);
    assert.equal(evidence.secondExitCode, EMPTY_COUNT);
    assert.equal(evidence.filesAfterFirstStop, EMPTY_COUNT);
    assert.equal(evidence.filesAfterSecondStop, EMPTY_COUNT);
    assert.equal(evidence.sensitiveOutputAbsent, true);
  },
);
