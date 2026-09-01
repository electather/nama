import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SUCCESS_EXIT_CODE = 0;

test(
  "records process-tree CPU and peak memory at worker scope",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nama-resource-measurement-"));
    const reportPath = join(directory, "resource.json");
    try {
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "run-with-resources.mjs"),
          reportPath,
          "fixture worker",
          process.execPath,
          "--eval",
          "const value = Buffer.alloc(1024 * 1024); setTimeout(() => process.stdout.write(String(value.length)), 80);",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      await once(child, "close");

      assert.equal(child.exitCode, SUCCESS_EXIT_CODE);
      const resource = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(resource.scope, "fixture worker");
      assert.ok(resource.cpuUserSeconds >= 0);
      assert.ok(resource.cpuSystemSeconds >= 0);
      assert.ok(resource.peakRssBytes > 1024 * 1024);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  "tolerates descendants exiting during a process-tree sample",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nama-resource-measurement-"));
    const reportPath = join(directory, "resource.json");
    try {
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "run-with-resources.mjs"),
          reportPath,
          "churning worker",
          process.execPath,
          "--eval",
          "const { spawn } = require('node:child_process'); for (let index = 0; index < 100; index += 1) spawn('/bin/true'); setTimeout(() => {}, 120);",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      await once(child, "close");

      assert.equal(child.exitCode, SUCCESS_EXIT_CODE);
      const resource = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(resource.scope, "churning worker");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
