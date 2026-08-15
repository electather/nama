import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/tests/**/*.test.ts", "integration/tests/**/*.test.ts"],
    maxWorkers: 1,
  },
});
