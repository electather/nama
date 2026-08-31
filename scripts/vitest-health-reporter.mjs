import {
  normalizeVitestRecords,
  runIdentityFromEnvironment,
  shuffleSeedFromEnvironment,
  writeReport,
} from "./test-health.mjs";

const SHARED_JELLYFIN_PROJECT = "shared-jellyfin";
const RESTART_MUTATING_TEST =
  "integration/tests/jellyfin-real-provider.process.integration.test.ts";

export default class VitestHealthReporter {
  activeSharedModule;
  overlap;
  sharedModules;

  constructor() {
    this.activeSharedModule = undefined;
    this.overlap = undefined;
    this.sharedModules = [];
  }

  onTestModuleStart(testModule) {
    if (testModule.project.name !== SHARED_JELLYFIN_PROJECT) {
      return;
    }
    if (this.activeSharedModule !== undefined) {
      this.overlap = `${this.activeSharedModule} and ${testModule.relativeModuleId}`;
    }
    this.activeSharedModule = testModule.relativeModuleId;
    this.sharedModules.push(testModule.relativeModuleId);
  }

  onTestModuleEnd(testModule) {
    if (
      testModule.project.name === SHARED_JELLYFIN_PROJECT &&
      this.activeSharedModule === testModule.relativeModuleId
    ) {
      this.activeSharedModule = undefined;
    }
  }

  async onTestRunEnd(testModules) {
    const reportPath = process.env["NAMA_TEST_HEALTH_REPORT"];
    if (reportPath !== undefined) {
      const records = [];
      for (const testModule of testModules) {
        const moduleDiagnostic = testModule.diagnostic();
        records.push({
          duration: moduleDiagnostic.duration,
          file: testModule.relativeModuleId,
          flaky: false,
          heap: moduleDiagnostic.heap,
          project: testModule.project.name,
          repeatCount: 0,
          retryCount: 0,
          state: testModule.state(),
          test: "(file)",
        });
        for (const testCase of testModule.children.allTests()) {
          const diagnostic = testCase.diagnostic();
          records.push({
            duration: diagnostic?.duration ?? 0,
            file: testModule.relativeModuleId,
            flaky: diagnostic?.flaky ?? false,
            heap: diagnostic?.heap,
            project: testModule.project.name,
            repeatCount: diagnostic?.repeatCount ?? 0,
            retryCount: diagnostic?.retryCount ?? 0,
            slow: diagnostic?.slow ?? false,
            state: testCase.result().state,
            test: testCase.fullName,
          });
        }
      }
      await writeReport(
        reportPath,
        normalizeVitestRecords(records, {
          run: runIdentityFromEnvironment(),
          shuffleSeed: shuffleSeedFromEnvironment(),
        }),
      );
    }
    if (this.overlap !== undefined) {
      throw new Error(`shared Jellyfin test files overlapped: ${this.overlap}`);
    }
    const restartIndex = this.sharedModules.indexOf(RESTART_MUTATING_TEST);
    if (restartIndex >= 0 && restartIndex !== this.sharedModules.length - 1) {
      throw new Error("restart-mutating Jellyfin test did not run last in the shared lane");
    }
  }
}
