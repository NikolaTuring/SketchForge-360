import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level regression tests for the editor.
 *
 * `SketchForgeEditor.tsx` is a single ~9,500-line component with no unit test
 * coverage, and vitest runs in a Node environment with no DOM. These tests are
 * the only thing that can catch a regression in the editor shell, so they run
 * against the real dev server in a real browser.
 *
 * Assertions read the hidden `pre[data-codex-state]` scene dump and `data-testid`
 * handles rather than visible text — user-facing strings are translated, and a
 * test that keys off them would break on every wording change.
 */

const PORT = Number(process.env.SKETCHFORGE_TEST_PORT ?? 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Some environments ship a preinstalled Chromium whose revision does not match
 * the one this Playwright version would download. Prefer an explicit override,
 * then a known preinstalled location, and otherwise let Playwright resolve its
 * own browser (the normal case, including CI).
 */
function resolveChromium(): string | undefined {
  const candidates = [process.env.SKETCHFORGE_CHROMIUM_PATH, "/opt/pw-browsers/chromium"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  return candidates.find((candidate) => existsSync(candidate));
}

const executablePath = resolveChromium();

export default defineConfig({
  testDir: "tests/ui",
  testMatch: "**/*.spec.ts",
  // The editor mutates shared browser storage (IndexedDB, localStorage), so the
  // specs run one at a time rather than racing each other for the same project.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Paste reads the system clipboard first. Without this permission Chromium
    // leaves `navigator.clipboard.readText()` pending forever instead of
    // rejecting, so the paste handler never reaches its fallbacks and the
    // command silently does nothing. Granting it matches a real user who has
    // allowed clipboard access.
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          // The viewport is WebGL; software rendering keeps it deterministic and
          // available on machines with no GPU.
          args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-lcd-text"],
        },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // A cold start stages the 22 MB OpenCascade runtime and then compiles the
    // route on first request, which is well past Playwright's default.
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
