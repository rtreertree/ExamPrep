import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/*.test.ts", "tests/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
