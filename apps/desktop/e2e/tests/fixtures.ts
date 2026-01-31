import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  test as base,
} from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extended test fixtures for Electron testing
 */
export const test = base.extend<{
  electronApp: ElectronApplication;
  window: Page;
}>({
  electronApp: async (_deps, use) => {
    // Build output path
    const appPath = path.join(__dirname, "../../dist/main/index.js");

    // Launch Electron app
    const app = await electron.launch({
      args: [appPath],
      env: {
        ...process.env,
        NODE_ENV: "test",
      },
    });

    await use(app);

    // Cleanup
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    // Wait for the first window to open
    const window = await electronApp.firstWindow();

    // Wait for app to be ready
    await window.waitForLoadState("domcontentloaded");

    await use(window);
  },
});

export { expect } from "@playwright/test";
