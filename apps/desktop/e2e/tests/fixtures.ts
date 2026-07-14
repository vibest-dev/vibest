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
  electronApp: ElectronApplication;
  window: Page;
}>({
  // Playwright requires the first parameter to be an object-destructuring
  // pattern, even when the fixture uses none of the others.
  // oxlint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
  electronApp: async ({}, use) => {
    const appPath = path.join(import.meta.dirname, "../../dist/main/index.js");

    const app = await electron.launch({
      args: [appPath],
      env: {
        ...process.env,
        NODE_ENV: "test",
      },
    });

    await use(app);

    await app.close();
  },

  window: async ({ electronApp }, use) => {
    // The main process spawns and awaits the backend before creating a window,
    // so the first window can take a few seconds to appear.
    const window = await electronApp.firstWindow({ timeout: 30_000 });

    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 900 });

    await use(window);
  },
});

export { expect } from "@playwright/test";
