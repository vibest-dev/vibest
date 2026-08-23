import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

import { expect, stopDaemonFor, test } from "./fixtures.js";

function appPid(electronApp: ElectronApplication): number {
  const pid = electronApp.process().pid;
  if (pid === undefined) throw new Error("Electron process has no pid");
  return pid;
}

function findServerPid(parentPid: number): number | undefined {
  const processes = childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  for (const line of processes.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    // Must track apps/desktop/src/main/desktop-config.ts's serverEntry: the
    // child is the built @vibest/server, not the CLI it used to be.
    if (Number(ppid) === parentPid && command.includes("packages/server/dist/server.mjs")) {
      return Number(pid);
    }
  }
  return undefined;
}

function serverPid(parentPid: number): number {
  const pid = findServerPid(parentPid);
  if (pid === undefined) throw new Error(`Server child of Electron ${parentPid} was not found`);
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function frontmostApplicationPid(): number | undefined {
  if (process.platform !== "darwin") return undefined;
  const application = childProcess
    .execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" })
    .trim();
  const info = childProcess.execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "pid", application],
    {
      encoding: "utf8",
    },
  );
  const match = info.match(/"pid"=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function waitForServer(parentPid: number): Promise<number> {
  await expect.poll(() => findServerPid(parentPid), { timeout: 30_000 }).toBeTruthy();
  return serverPid(parentPid);
}

async function waitForDifferentServer(parentPid: number, previousPid: number): Promise<number> {
  await expect
    .poll(
      () => {
        const pid = findServerPid(parentPid);
        return pid === undefined || pid === previousPid ? previousPid : pid;
      },
      { timeout: 15_000 },
    )
    .not.toBe(previousPid);
  return serverPid(parentPid);
}

/**
 * The server child appears well before it reports ready, and a first spawn
 * killed pre-ready is a boot failure by design (terminal state, no respawn).
 * These kill tests mean "kill a running server", so wait until the renderer
 * left the splash — that requires the ready handshake to have completed.
 */
async function waitForConnectedUi(window: Page): Promise<void> {
  // The splash carries "Starting Vibest" as an aria-label, not text content,
  // and unmounts permanently once the renderer connects.
  await expect(window.getByRole("main", { name: "Starting Vibest" })).toBeHidden({
    timeout: 30_000,
  });
}

async function driveServerToFailed(window: Page, parentPid: number): Promise<void> {
  await waitForConnectedUi(window);
  let currentPid = await waitForServer(parentPid);
  for (let failure = 0; failure < 6; failure += 1) {
    process.kill(currentPid, "SIGKILL");
    if (failure < 5) currentPid = await waitForDifferentServer(parentPid, currentPid);
  }
}

test("renders in the background without taking focus and connects to the server", async ({
  electronApp,
  window,
}) => {
  await expect(window).toHaveTitle("Vibest");
  await expect(window.locator("#root")).toBeVisible();
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
  await expect(
    electronApp.evaluate(({ BrowserWindow }) => {
      const browserWindow = BrowserWindow.getAllWindows()[0];
      return { visible: browserWindow?.isVisible(), focused: browserWindow?.isFocused() };
    }),
  ).resolves.toEqual({ visible: false, focused: false });
  const renderSize = await window.locator("#root").evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  expect(renderSize.width).toBeGreaterThan(0);
  expect(renderSize.height).toBeGreaterThan(0);
  expect(frontmostApplicationPid()).not.toBe(appPid(electronApp));
  await expect(
    window.evaluate(() => {
      // Runs in the renderer, where `window` is the DOM window, not the Page.
      const globals = window as unknown as Window & {
        vibest?: unknown;
        require?: unknown;
        process?: unknown;
      };
      return {
        vibest: typeof globals.vibest,
        require: typeof globals.require,
        process: typeof globals.process,
      };
    }),
  ).resolves.toEqual({ vibest: "undefined", require: "undefined", process: "undefined" });
});

test("gives a reloaded renderer document a new MessagePort", async ({ electronApp, window }) => {
  const pid = await waitForServer(appPid(electronApp));

  await window.reload();
  await expect(window).toHaveTitle("Vibest");
  await expect(window.locator("#root")).toBeVisible();
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
  expect(serverPid(appPid(electronApp))).toBe(pid);
});

// oxlint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
test("boots the development HTTP renderer through MessagePort", async ({}, testInfo) => {
  const rendererRoot = path.join(import.meta.dirname, "../../dist/renderer");
  const server = http.createServer((request, response) => {
    const requested = path.join(
      rendererRoot,
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    const target =
      fs.existsSync(requested) && fs.statSync(requested).isFile()
        ? requested
        : path.join(rendererRoot, "index.html");
    response.setHeader(
      "Content-Type",
      target.endsWith(".js")
        ? "text/javascript"
        : target.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    fs.createReadStream(target).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Development server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  // Own userData so its single-instance lock can't collide with a real `dev`.
  const userData = path.join(testInfo.outputPath(), "user-data");
  fs.mkdirSync(userData, { recursive: true });
  // Own server storage so the developer's real ~/.vibest never leaks in.
  const vibestHome = path.join(testInfo.outputPath(), "vibest-home");
  fs.mkdirSync(vibestHome, { recursive: true });

  const app = await electron.launch({
    args: [
      path.join(import.meta.dirname, "../../dist/main/index.js"),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: "development",
      ELECTRON_RENDERER_URL: origin,
      VIBEST_E2E: "1",
      VIBEST_HOME: vibestHome,
    },
  });

  try {
    const window = await app.firstWindow({ timeout: 30_000 });
    await expect(window).toHaveTitle("Vibest");
    await expect(window.getByText("Vibest could not start")).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // This test builds its own $VIBEST_HOME instead of using the fixture, so
    // it also owns stopping the per-test daemon.
    await stopDaemonFor(vibestHome);
  }
});

test("chats through Claude Agent SDK and the fake Claude executable", async ({
  e2ePaths,
  window,
}) => {
  // The app lands on /draft, the new-session surface: picking the seeded
  // project and typing the first message creates the session and navigates
  // into it. There is no default project — the composer blocks until one is
  // chosen.
  await waitForConnectedUi(window);

  await window.getByRole("combobox").filter({ hasText: "Select a project" }).click();
  await window.getByRole("option", { name: /e2e-workspace/ }).click();

  const input = window.locator("[contenteditable='true']");
  await input.fill("Desktop SDK E2E");
  await input.press("Enter");

  await expect(window).toHaveURL(/\/session\/[0-9a-f-]+/);
  // Scoped to the transcript: the prompt text also becomes the session's
  // optimistic title in the sidebar.
  const transcript = window.getByRole("log");
  await expect(transcript.getByText("Desktop SDK E2E", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Desktop fake Claude reply", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      fs.existsSync(e2ePaths.fakeClaudeLog) ? fs.readFileSync(e2ePaths.fakeClaudeLog, "utf8") : "",
    )
    .toContain('"type":"user","text":"Desktop SDK E2E"');
});

test("reports a server crash and recovers on the pinned connection", async ({
  electronApp,
  window,
}) => {
  await waitForConnectedUi(window);
  const initialPid = await waitForServer(appPid(electronApp));
  process.kill(initialPid, "SIGKILL");

  const reconnecting = window.getByText("Reconnecting…");
  await expect(reconnecting).toBeVisible({ timeout: 10_000 });
  await expect(reconnecting).toBeHidden({ timeout: 15_000 });

  const restartedPid = serverPid(appPid(electronApp));
  expect(restartedPid).not.toBe(initialPid);
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
});

test("leaves the daemon running through Electron shutdown", async ({ electronApp, window }) => {
  await expect(window).toHaveTitle("Vibest");
  const pid = await waitForServer(appPid(electronApp));

  await electronApp.close();

  // The server is the shared vibest daemon the app attached to (or spawned) —
  // it deliberately outlives Electron so the CLI and the next app launch
  // converge on the same backend. `vibest daemon stop` is how it ends (the
  // fixture teardown does the equivalent for the per-test daemon).
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(processExists(pid)).toBe(true);
});

test("offers Retry after repeated server failures", async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const parentPid = appPid(electronApp);
  await driveServerToFailed(window, parentPid);

  await expect(window.getByText("The local server stopped")).toBeVisible({ timeout: 10_000 });
  await window.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => findServerPid(parentPid), { timeout: 10_000 }).toBeTruthy();
  await expect(window.getByText("The local server stopped")).toBeHidden({ timeout: 10_000 });
  // Wait for the recovery to complete, not just the respawn to appear: quitting
  // while the replacement server is still booting can hang the app shutdown
  // (known issue), and teardown closes the app right after this test ends.
  await expect(window.getByText("Reconnecting…")).toBeHidden({ timeout: 15_000 });
});

test("quits through Desktop RPC from the terminal failure state", async ({
  electronApp,
  window,
}) => {
  test.setTimeout(60_000);
  const parentPid = appPid(electronApp);
  await driveServerToFailed(window, parentPid);
  await expect(window.getByText("The local server stopped")).toBeVisible({ timeout: 10_000 });

  await window.getByRole("button", { name: "Quit" }).click();

  await expect.poll(() => processExists(parentPid), { timeout: 5_000 }).toBe(false);
});
