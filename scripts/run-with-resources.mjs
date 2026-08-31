import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FAILURE_EXIT_CODE = 1;
const MINIMUM_ARGUMENT_COUNT = 3;
const SAMPLE_INTERVAL_MILLISECONDS = 250;
const STAT_RSS_INDEX = 21;
const STAT_SYSTEM_TICKS_INDEX = 12;
const STAT_USER_TICKS_INDEX = 11;

const [outputPath, scope, command, ...commandArguments] = process.argv.slice(2);
if (process.platform !== "linux" || process.argv.slice(2).length < MINIMUM_ARGUMENT_COUNT) {
  throw new Error(
    "usage: run-with-resources.mjs <output> <scope> <command> [arguments...] on Linux",
  );
}

const clockTicksPerSecond = Number(
  execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
);
const pageSizeBytes = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim());
if (!Number.isFinite(clockTicksPerSecond) || !Number.isFinite(pageSizeBytes)) {
  throw new Error("could not determine Linux process accounting units");
}

const cpuTicksByProcess = new Map();
let peakRssBytes = 0;

const readProcessTree = async (processId, observed) => {
  if (observed.has(processId)) {
    return [];
  }
  observed.add(processId);
  try {
    const [stat, children] = await Promise.all([
      readFile(`/proc/${processId}/stat`, "utf8"),
      readFile(`/proc/${processId}/task/${processId}/children`, "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return [];
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const processes = [
      {
        processId,
        rssPages: Number(fields[STAT_RSS_INDEX]),
        systemTicks: Number(fields[STAT_SYSTEM_TICKS_INDEX]),
        userTicks: Number(fields[STAT_USER_TICKS_INDEX]),
      },
    ];
    const childProcesses = children.trim().split(/\s+/u).filter(Boolean);
    for (const childProcess of childProcesses) {
      processes.push(...(await readProcessTree(Number(childProcess), observed)));
    }
    return processes;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return [];
    }
    throw error;
  }
};

const sample = async (rootProcessId) => {
  const processes = await readProcessTree(rootProcessId, new Set());
  let rssBytes = 0;
  for (const process of processes) {
    rssBytes += process.rssPages * pageSizeBytes;
    const previous = cpuTicksByProcess.get(process.processId);
    cpuTicksByProcess.set(process.processId, {
      systemTicks: Math.max(previous?.systemTicks ?? 0, process.systemTicks),
      userTicks: Math.max(previous?.userTicks ?? 0, process.userTicks),
    });
  }
  peakRssBytes = Math.max(peakRssBytes, rssBytes);
};

const child = spawn(command, commandArguments, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

let samples = sample(child.pid);
const interval = setInterval(() => {
  samples = samples.then(() => sample(child.pid));
}, SAMPLE_INTERVAL_MILLISECONDS);
const [exitCode] = await new Promise((resolve) => {
  child.once("exit", (...result) => {
    resolve(result);
  });
});
clearInterval(interval);
await samples;

let userTicks = 0;
let systemTicks = 0;
for (const usage of cpuTicksByProcess.values()) {
  userTicks += usage.userTicks;
  systemTicks += usage.systemTicks;
}
const resource = {
  cpuSystemSeconds: systemTicks / clockTicksPerSecond,
  cpuUserSeconds: userTicks / clockTicksPerSecond,
  peakRssBytes,
  sampleIntervalMilliseconds: SAMPLE_INTERVAL_MILLISECONDS,
  scope,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(resource)}\n`, { encoding: "utf8", mode: 0o600 });
process.exitCode = typeof exitCode === "number" ? exitCode : FAILURE_EXIT_CODE;
