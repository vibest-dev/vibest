import childProcess from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { PROJECT_ID, seedProject } from "./fixtures.js";

/**
 * Browser-mode multi-client session sync. Unlike the Electron spec, this
 * drives `vibest serve` (the daemon's foreground form) plus two ordinary
 * browser pages on the same session — the shape multi-client sync exists for.
 *
 * The harness is the fake Claude executable, so scenarios are limited to what
 * it can produce: instant single-message turns, no tool calls, and no on-disk
 * transcript. The last one matters: a client attaching after a turn ended
 * cannot backfill it from history (the real fix for that is a history read),
 * so every assertion below is about turns a client either observed live or
 * recovered from the runtime snapshot.
 *
 * Prerequisite: the SPA must be built (`turbo run build --filter=@vibest/app`)
 * — serve has no dev branch and serves `apps/app/dist` statically.
 */

const repoRoot = path.join(import.meta.dirname, "../../../..");
const appDist = path.join(repoRoot, "apps/app/dist");
const fakeClaude = path.join(repoRoot, "tools/testing/fake-claude.mjs");

const FAKE_REPLY = "E2E fake Claude reply";

test.skip(
  !fs.existsSync(path.join(appDist, "index.html")),
  "apps/app/dist is missing — build the SPA first (turbo run build --filter=@vibest/app)",
);

let server: childProcess.ChildProcessWithoutNullStreams | undefined;
let baseUrl = "";

// oxlint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
test.beforeAll(async ({}, testInfo) => {
  const home = testInfo.outputPath("vibest-home");
  seedProject(home, testInfo.outputPath("workspace"));

  server = childProcess.spawn(
    path.join(repoRoot, "node_modules/.bin/tsx"),
    [path.join(repoRoot, "packages/vibest/src/node/cli.ts"), "serve"],
    {
      env: {
        ...process.env,
        VIBEST_PORT: "0",
        VIBEST_HOME: home,
        VIBEST_E2E: "1",
        VIBEST_E2E_CLAUDE_EXECUTABLE: fakeClaude,
        VIBEST_E2E_CLAUDE_LOG: testInfo.outputPath("fake-claude.jsonl"),
        VIBEST_E2E_CLAUDE_RESPONSE: FAKE_REPLY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`vibest serve never became ready:\n${output}`)),
      30_000,
    );
    const scan = (chunk: Buffer) => {
      output += chunk.toString();
      const ready = output.match(/vibest:ready\s*({.+})/);
      if (ready?.[1]) {
        clearTimeout(timeout);
        const { port } = JSON.parse(ready[1]) as { port: number };
        resolve(`http://127.0.0.1:${port}`);
      }
    };
    server?.stdout.on("data", scan);
    server?.stderr.on("data", scan);
    server?.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`vibest serve exited with ${code}:\n${output}`));
    });
  });
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  server = undefined;
});

const send = async (page: Page, text: string) => {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.pressSequentially(text);
  // Enter is a newline in the composer; submission is the button.
  await page.locator('button[type="submit"]').last().click();
};

/** Create a session through the draft surface (the real `open` path) and
 * return once the first turn's reply landed. */
const createSession = async (browser: Browser, firstPrompt: string): Promise<Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Draft config lives in the URL, so the project and harness are picked
  // deterministically instead of driving two dropdowns.
  await page.goto(`${baseUrl}/draft?projectId=${PROJECT_ID}&harness=claude-code`);
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20_000 });
  await send(page, firstPrompt);
  await page.waitForURL(/\/session\//, { timeout: 20_000 });
  await expect(page.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 15_000 });
  return page;
};

const joinSession = async (browser: Browser, sessionUrl: string): Promise<Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(sessionUrl);
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20_000 });
  return page;
};

test("two clients on one session render each other's turns live", async ({ browser }) => {
  const pageA = await createSession(browser, "first prompt from A");
  const pageB = await joinSession(browser, pageA.url());

  // A → B: the prompt broadcast and the folded turn reach the observer.
  await send(pageA, "second prompt from A");
  await expect(pageB.getByText("second prompt from A")).toBeVisible({ timeout: 15_000 });
  await expect(pageB.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 15_000 });

  // B → A: same path in the other direction — no client is special.
  await send(pageB, "hello from client B");
  await expect(pageA.getByText("hello from client B")).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText(FAKE_REPLY)).toHaveCount(3, { timeout: 15_000 });
  await expect(pageB.getByText(FAKE_REPLY)).toHaveCount(2, { timeout: 15_000 });
});

// A TCP proxy in front of the server, so a test can sever a client's
// connections deterministically. (`context.setOffline` is not reliable here:
// Chromium does not always terminate an established WebSocket, leaving the
// client on a half-open socket that never errors — flaky by construction.)
type TcpProxy = { readonly port: number; readonly stop: () => Promise<void> };
const startProxy = (upstreamPort: number, port = 0): Promise<TcpProxy> =>
  new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const listener = net.createServer((client) => {
      const target = net.connect(upstreamPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(target);
      client.pipe(target);
      target.pipe(client);
      const drop = () => {
        sockets.delete(client);
        sockets.delete(target);
        client.destroy();
        target.destroy();
      };
      client.on("close", drop);
      target.on("close", drop);
      client.on("error", () => undefined);
      target.on("error", () => undefined);
    });
    listener.listen(port, "127.0.0.1", () => {
      resolve({
        port: (listener.address() as AddressInfo).port,
        // Destroys live connections and stops accepting new ones: severed
        // clients see a real TCP error, retries see connection refused.
        stop: () =>
          new Promise((done) => {
            listener.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });

test("a disconnected client recovers a turn it missed, without a reload", async ({ browser }) => {
  const pageA = await createSession(browser, "warm-up turn");
  // B reaches the server through the severable proxy; A connects directly.
  const serverPort = Number(new URL(baseUrl).port);
  const proxy = await startProxy(serverPort);
  const sessionUrl = new URL(pageA.url());
  const pageB = await joinSession(
    browser,
    `http://127.0.0.1:${proxy.port}${sessionUrl.pathname}${sessionUrl.search}`,
  );
  // A barrier turn B observes live: it proves B's first attach completed
  // before the drop. (Severing during the initial attach would turn the
  // recovery into a *first* attach, where a completed buffer defers to the
  // history floor — which the fake harness cannot provide.)
  await send(pageA, "barrier turn");
  await expect(pageB.getByText("barrier turn")).toBeVisible({ timeout: 15_000 });

  // Sever B: its event stream dies with a real error, and reconnect attempts
  // are refused while the proxy is down.
  await proxy.stop();
  await send(pageA, "sent while B was offline");
  await expect(pageA.getByText(FAKE_REPLY)).toHaveCount(3, { timeout: 15_000 });
  await expect(pageB.getByText("sent while B was offline")).toBeHidden();

  // The proxy returns on the same port: the transport's retry loop re-attaches
  // on its own, and the snapshot replays the retained prompt and completed
  // turn buffer.
  const revived = await startProxy(serverPort, proxy.port);
  await expect(pageB.getByText("sent while B was offline")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 30_000 });
  await revived.stop();
});
