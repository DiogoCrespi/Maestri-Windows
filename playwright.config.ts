import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    browserName: "chromium",
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // Exercise the compiled application. Starting three browsers against a
    // cold Vite dev optimizer is flaky on Windows because dependency
    // re-bundling can restart requests while Playwright is navigating.
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 1420",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
