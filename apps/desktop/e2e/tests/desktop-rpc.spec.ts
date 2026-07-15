import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { _electron as electron } from "@playwright/test";

import { expect, test } from "./fixtures";

function findBackendPid(parentPid: number): number | undefined {
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  for (const line of processes.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (Number(ppid) === parentPid && command.includes("packages/vibest/dist/cli.mjs")) {
      return Number(pid);
    }
  }
  return undefined;
}

function backendPid(parentPid: number): number {
  const pid = findBackendPid(parentPid);
  if (pid === undefined) throw new Error(`Backend child of Electron ${parentPid} was not found`);
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

async function waitForDifferentBackend(parentPid: number, previousPid: number): Promise<number> {
  await expect
    .poll(
      () => {
        const pid = findBackendPid(parentPid);
        return pid === undefined || pid === previousPid ? previousPid : pid;
      },
      { timeout: 15_000 },
    )
    .not.toBe(previousPid);
  return backendPid(parentPid);
}

async function driveBackendToFailed(parentPid: number): Promise<void> {
  let currentPid = backendPid(parentPid);
  for (let failure = 0; failure < 6; failure += 1) {
    process.kill(currentPid, "SIGKILL");
    if (failure < 5) currentPid = await waitForDifferentBackend(parentPid, currentPid);
  }
}

test("boots the renderer through an oRPC MessagePort", async ({ window }) => {
  await expect(window).toHaveTitle("Vibest");
  await expect(window.locator("#root")).toBeVisible();
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
  await expect(
    window.evaluate(() => {
      const globals = window as Window & {
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
  const pid = backendPid(electronApp.process().pid);

  await window.reload();
  await expect(window).toHaveTitle("Vibest");
  await expect(window.locator("#root")).toBeVisible();
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
  expect(backendPid(electronApp.process().pid)).toBe(pid);
});

test("boots the development HTTP renderer through MessagePort", async () => {
  const rendererRoot = path.join(import.meta.dirname, "../../dist/renderer");
  const server = createServer((request, response) => {
    const requested = path.join(
      rendererRoot,
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    const target =
      existsSync(requested) && statSync(requested).isFile()
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
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Development server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  const app = await electron.launch({
    args: [path.join(import.meta.dirname, "../../dist/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      ELECTRON_RENDERER_URL: origin,
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
  }
});

test("reports a backend crash and recovers on the pinned connection", async ({
  electronApp,
  window,
}) => {
  const initialPid = backendPid(electronApp.process().pid);
  process.kill(initialPid, "SIGKILL");

  const reconnecting = window.getByText("Reconnecting…");
  await expect(reconnecting).toBeVisible({ timeout: 10_000 });
  await expect(reconnecting).toBeHidden({ timeout: 15_000 });

  const restartedPid = backendPid(electronApp.process().pid);
  expect(restartedPid).not.toBe(initialPid);
  await expect(window.getByText("Vibest could not start")).toHaveCount(0);
});

test("disposes the backend process during Electron shutdown", async ({ electronApp, window }) => {
  await expect(window).toHaveTitle("Vibest");
  const pid = backendPid(electronApp.process().pid);

  await electronApp.close();

  await expect.poll(() => processExists(pid), { timeout: 5_000 }).toBe(false);
});

test("offers Retry after repeated backend failures", async ({ electronApp, window }) => {
  test.setTimeout(60_000);
  const parentPid = electronApp.process().pid;
  await driveBackendToFailed(parentPid);

  await expect(window.getByText("The local server stopped")).toBeVisible({ timeout: 10_000 });
  await window.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => findBackendPid(parentPid), { timeout: 10_000 }).toBeTruthy();
  await expect(window.getByText("The local server stopped")).toBeHidden({ timeout: 10_000 });
});

test("quits through Desktop RPC from the terminal failure state", async ({
  electronApp,
  window,
}) => {
  test.setTimeout(60_000);
  const parentPid = electronApp.process().pid;
  await driveBackendToFailed(parentPid);
  await expect(window.getByText("The local server stopped")).toBeVisible({ timeout: 10_000 });

  await window.getByRole("button", { name: "Quit" }).click();

  await expect.poll(() => processExists(parentPid), { timeout: 5_000 }).toBe(false);
});
