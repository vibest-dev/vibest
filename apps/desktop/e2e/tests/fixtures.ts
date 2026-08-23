import fs from "node:fs";
import path from "node:path";

import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  test as base,
} from "@playwright/test";

/** The one seeded project's id — the contract validates projectId as a UUID. */
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Seed one project into a per-test `$VIBEST_HOME`: a fresh home renders the
 * first-project onboarding instead of the composer, so chat flows need a
 * project up front.
 */
export function seedProject(vibestHome: string, workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  const storage = path.join(vibestHome, "storage");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "projects.json"),
    JSON.stringify({
      version: 1,
      data: [
        {
          id: PROJECT_ID,
          name: "e2e-workspace",
          path: workspace,
          createdAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    }),
  );
}

/**
 * Stop the daemon recorded under this home. The app attaches to (or spawns)
 * the shared vibest daemon, which deliberately outlives Electron; with a
 * per-test `$VIBEST_HOME` that means a per-test daemon — stop it in teardown
 * or every test leaks one.
 */
export async function stopDaemonFor(vibestHome: string): Promise<void> {
  try {
    const record = JSON.parse(
      await fs.promises.readFile(path.join(vibestHome, "daemon", "daemon.pid"), "utf8"),
    ) as { pid?: number };
    if (typeof record.pid === "number" && record.pid > 0) {
      process.kill(record.pid, "SIGTERM");
    }
  } catch {
    // No daemon record (never spawned) or the process is already gone.
  }
}

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
    fs.mkdirSync(output, { recursive: true });
    // Per-test server storage: without this the spawned server resolves
    // $VIBEST_HOME to the developer's real ~/.vibest, so their projects and
    // sessions leak into the UI and test chats write into their history.
    const vibestHome = path.join(output, "vibest-home");
    fs.mkdirSync(vibestHome, { recursive: true });
    seedProject(vibestHome, path.join(output, "workspace"));
    await use({
      fakeClaudeLog: path.join(output, "fake-claude.jsonl"),
      userData: path.join(output, "user-data"),
      vibestHome,
    });

    await stopDaemonFor(vibestHome);
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
