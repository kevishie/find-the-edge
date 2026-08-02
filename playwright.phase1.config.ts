import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["FTE_PHASE1_BROWSER_BASE_URL"];
if (!baseURL) throw new Error("FTE_PHASE1_BROWSER_BASE_URL is required");

export default defineConfig({
  testDir: "./tests/phase1-e2e",
  outputDir: "test-results/phase1",
  preserveOutput: "never",
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [
    { name: "phase1-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
