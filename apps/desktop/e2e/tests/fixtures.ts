import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  test as base,
} from "@playwright/test";

/**
 * Extended test fixtures for Electron testing
 */
export const test = base.extend<{
  e2ePaths: {
    fakeClaudeLog: string;
    userData: string;
    vibestHome: string;
  };
  electronApp: ElectronApplication;
  window: Page;
}>({
  // oxlint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
  e2ePaths: async ({}, use, testInfo) => {
    const output = testInfo.outputPath();
    mkdirSync(output, { recursive: true });
    // Per-test server storage: without this the spawned server resolves
    // $VIBEST_HOME to the developer's real ~/.vibest, so their projects and
    // sessions leak into the UI and test chats write into their history.
    const vibestHome = path.join(output, "vibest-home");
    mkdirSync(vibestHome, { recursive: true });
    await use({
      fakeClaudeLog: path.join(output, "fake-claude.jsonl"),
      userData: path.join(output, "user-data"),
      vibestHome,
    });
  },

  // Playwright requires the first parameter to be an object-destructuring
  // pattern, even when the fixture uses none of the others.
  // oxlint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
  electronApp: async ({ e2ePaths }, use) => {
    const appPath = path.join(import.meta.dirname, "../../dist/main/index.js");
    const fakeClaudePath = path.join(
      import.meta.dirname,
      "../../../../tools/testing/fake-claude.mjs",
    );

    const app = await electron.launch({
      args: [appPath, `--user-data-dir=${e2ePaths.userData}`],
      env: {
        ...process.env,
        NODE_ENV: "test",
        VIBEST_E2E: "1",
        VIBEST_E2E_CLAUDE_EXECUTABLE: fakeClaudePath,
        VIBEST_E2E_CLAUDE_LOG: e2ePaths.fakeClaudeLog,
        VIBEST_E2E_CLAUDE_RESPONSE: "Desktop fake Claude reply",
        VIBEST_HOME: e2ePaths.vibestHome,
      },
    });

    await use(app);

    await app.close();
  },

  window: async ({ electronApp }, use) => {
    // The window opens while the server starts; keep a generous timeout for
    // slower CI machines and Electron process startup itself.
    const window = await electronApp.firstWindow({ timeout: 30_000 });

    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 900 });

    await use(window);
  },
});

export { expect } from "@playwright/test";
