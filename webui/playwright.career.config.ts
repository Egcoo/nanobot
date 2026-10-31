import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "career-real.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  outputDir: "test-results/career",
  use: {
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    screenshot: "only-on-failure",
  },
});
