import fs from "node:fs";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  test as base,
} from "@playwright/test";
import { pidAlive, readRecord, resolveDaemonLocation, stopDaemon } from "@vibest/server/daemon";
import { Effect, FileSystem } from "effect";

const provideFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

function e2eDaemonLocation(home: string) {
  return resolveDaemonLocation({ VIBEST_HOME: home });
}

export function stopE2eDaemon(home: string): Promise<"stopped" | "not-running"> {
  const { daemonDir, legacyDaemonDir } = e2eDaemonLocation(home);
  return provideFileSystem(stopDaemon(daemonDir, legacyDaemonDir));
}

/**
 * Stop the daemon and report the pid it left running, if any.
 *
 * `stopDaemon`'s own answer cannot carry this: `"not-running"` is the correct
 * result for every test that drives the server to a terminal failure, so it
 * says nothing about whether a process survived. Reading the record first and
 * re-checking that pid afterwards does.
 */
export async function stopE2eDaemonAndDetectLeak(home: string): Promise<number | undefined> {
  const { daemonDir } = e2eDaemonLocation(home);
  const record = await provideFileSystem(readRecord(daemonDir));
  await stopE2eDaemon(home);
  return record !== undefined && pidAlive(record.pid) ? record.pid : undefined;
}

export async function waitForE2eDaemon(home: string, timeoutMs = 30_000): Promise<boolean> {
  const { daemonDir, legacyDaemonDir } = e2eDaemonLocation(home);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      (await provideFileSystem(readRecord(daemonDir))) !== undefined ||
      (legacyDaemonDir !== undefined &&
        (await provideFileSystem(readRecord(legacyDaemonDir))) !== undefined)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

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

    try {
      await use({
        fakeClaudeLog: path.join(output, "fake-claude.jsonl"),
        userData: path.join(output, "user-data"),
        vibestHome,
      });
    } finally {
      // Also runs when a dependent fixture fails during setup.
      await stopE2eDaemon(vibestHome);
    }
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

    let leakedPid: number | undefined;
    try {
      await use(app);
    } finally {
      // The discovery result used to be discarded outright, so a 30s timeout
      // was indistinguishable from an instant hit and the teardown below went
      // on to stop a daemon it had never found.
      const discovered = await waitForE2eDaemon(e2ePaths.vibestHome);
      if (!discovered) {
        console.warn(`e2e daemon never published a record (home=${e2ePaths.vibestHome})`);
      }
      try {
        await app.close();
      } finally {
        leakedPid = await stopE2eDaemonAndDetectLeak(e2ePaths.vibestHome);
      }
    }
    // Only reached when the test body itself passed, so a leak can never mask
    // the real failure.
    if (leakedPid !== undefined) {
      throw new Error(`e2e daemon ${leakedPid} survived teardown (home=${e2ePaths.vibestHome})`);
    }
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
