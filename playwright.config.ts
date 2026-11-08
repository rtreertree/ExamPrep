import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 240000,
  expect: { timeout: 10000 },
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://127.0.0.1:8787",
    viewport: { width: 1536, height: 1024 },
    trace: "off",
  },
  reporter: "list",
  outputDir: "/tmp/examprep-browser-results",
});
