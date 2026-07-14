# Web as Electron UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing chat web app (`apps/web`, renamed to `apps/app`) the Electron desktop UI, backed by the existing `@vibest/cli` server spawned as a child process, and delete the obsolete worktree/task/terminal desktop app.

**Architecture:** Electron's main process spawns `@vibest/cli`'s built server using Electron's own Node runtime (`ELECTRON_RUN_AS_NODE=1`), on a loopback OS-assigned port, guarded by a per-launch bearer token. The renderer's HTML/JS/CSS are served **off disk** by a `vibest://app` custom protocol (never a proxy); the renderer calls the backend at its real `http://127.0.0.1:<port>` origin, which the server permits via a CORS allowlist. WebSocket RPC connects directly to loopback, authenticated with a single-use ticket, because a custom protocol cannot proxy a WS upgrade and browsers cannot set headers on a WS handshake. Browser mode (`npx vibest`) stays fully supported: host differences are expressed as a `Platform` discriminated union injected by each entry point, not sniffed at runtime.

**Tech Stack:** Electron 41 + electron-vite + electron-builder; React 19 + Vite + TanStack Router/Query; oRPC 2.0.0-beta.16 (fetch + websocket links); Node `http` + `ws` + `sirv`; Vitest; Playwright (Electron).

## Global Constraints

- **oRPC is pinned to `2.0.0-beta.16`** across the workspace (`pnpm-workspace.yaml` `overrides`). Do not float it to stable — the stable client imports `ORPC_HEADER`, absent from the beta contract.
- **Package manager is pnpm; task runner is Turborepo.** Run tasks from the repo root (`pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm check`). Never `npx` — use `pnpm dlx`/`pnpm exec`.
- **Lint/format is Oxlint + Oxfmt from the repo root** (`pnpm lint`, `pnpm format`). Do not add ESLint/Prettier configs.
- **Existing on-disk names are load-bearing.** The server's HTTP RPC prefix is exactly `/api/rpc`; the WS RPC path is exactly `/ws/rpc`; the WS subprotocol is exactly `"vibest"`; the health endpoint is exactly `/api/health`.
- **Never commit secrets.** The auth token is generated per launch at runtime; it must never be written to a file, a log line, or a commit.
- **Commit messages carry no AI/Claude annotations.**
- The desktop app's `productName` is `Vibest` and its `appId` is `com.vibest.desktop` (`apps/desktop/electron-builder.yml`). Keep both.

---

## File Structure

**Renamed:**

- `apps/web/` → `apps/app/` (package `@vibest/web` → `@vibest/app`)

**Created:**

- `apps/app/src/platform.ts` — the `Platform` discriminated union; the single seam between hosts.
- `apps/app/src/app.tsx` — `createApp(platform)`: builds clients, router, chat manager; returns the React tree. Both entries call it.
- `apps/app/vite.shared.ts` — the Vite plugin list + `@` alias, shared by `apps/app`'s own Vite config and `apps/desktop`'s electron-vite renderer config.
- `packages/vibest/src/node/auth.ts` — bearer-token parsing/compare + the single-use WS ticket store.
- `packages/vibest/src/node/cors.ts` — CORS header computation against an origin allowlist.
- `packages/vibest/src/node/handshake.ts` — the stdout ready-line protocol, shared by the server and the desktop supervisor.
- `packages/vibest/vitest.config.ts` — test config for the above.
- `apps/desktop/src/shared/bridge.ts` — the preload bridge's type (`DesktopBridge`).
- `apps/desktop/src/main/backend.ts` — spawns/supervises the `@vibest/cli` server child process.
- `apps/desktop/src/main/protocol.ts` — the `vibest://app` static-file protocol handler with SPA fallback.
- `apps/desktop/src/renderer/main.tsx` — the desktop entry point; constructs the desktop `Platform`.

**Deleted:**

- `apps/desktop/src/renderer/src/**` — the entire old worktree/task/terminal UI.
- `apps/desktop/src/main/app.ts`, `src/main/services/**`, `src/main/terminal/**`, `src/main/ipc/**`, `src/main/infra/**`, `src/shared/contract/**`, `src/shared/types.ts`.

**Substantially modified:**

- `packages/vibest/src/node/server.ts` — auth, CORS, ticket endpoint, ticketed WS upgrade.
- `packages/vibest/src/node/cli.ts` — env-var config, token scrub, dynamic port, ready line.
- `packages/client/src/index.ts` — `headers` option on the HTTP client; `getTicket` option on the WS client.
- `apps/app/src/lib/orpc.ts` — module-scope singletons become `createAppClients(platform)`.
- `apps/desktop/src/main/index.ts` — single-instance lock, backend spawn, protocol registration, window creation.
- `apps/desktop/src/preload/index.ts` — exposes the `DesktopBridge`.
- `apps/desktop/electron.vite.config.ts`, `electron-builder.yml`, `package.json`, `tsconfig.*.json`.
- `apps/desktop/e2e/tests/*` — rewritten against the chat UI.

`packages/services` **stays in the tree, unreferenced.** Do not delete it; do remove `@vibest/services` from `apps/desktop`'s dependencies, since nothing in the new desktop app imports it.

---

## Task 1: Rename `apps/web` → `apps/app`

**Files:**

- Move: `apps/web/` → `apps/app/`
- Modify: `apps/app/package.json` (name)
- Modify: `packages/vibest/src/node/server.ts:31-33` (static dir + vite root paths)

**Interfaces:**

- Produces: workspace package `@vibest/app` at `apps/app`, replacing `@vibest/web`.

- [ ] **Step 1: Move the directory with git**

```bash
git mv apps/web apps/app
```

- [ ] **Step 2: Rename the package**

In `apps/app/package.json`, change the name field:

```json
  "name": "@vibest/app",
```

- [ ] **Step 3: Update the server's path references**

`packages/vibest/src/node/server.ts` — the `resolveStaticDir()` candidates and the dev Vite root both hardcode `apps/web`. Replace the whole `resolveStaticDir` function and the dev `root` option:

```ts
/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    new URL("./client/", import.meta.url), // packaged: dist/client next to dist/cli.js
    new URL("../../../../apps/app/dist/", import.meta.url), // monorepo, from src/node
    new URL("../../../apps/app/dist/", import.meta.url), // monorepo, from packages/vibest/dist
  ];
  for (const candidate of candidates) {
    const dir = path.resolve(fileURLToPath(candidate));
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}
```

And in the `isDev` branch of `createServer`:

```ts
const vite = await createViteDevServer({
  // Serve the standalone web app package (apps/app) through this server.
  root: path.resolve(fileURLToPath(new URL("../../../../apps/app/", import.meta.url))),
  server: {
    middlewareMode: true,
    hmr: {
      server,
    },
  },
});
```

Also update the 503 message in the same file:

```ts
serveUI = (_req, res) => {
  res.statusCode = 503;
  res.end("Web UI not built. Run the @vibest/app build first.");
};
```

- [ ] **Step 4: Verify no stale references remain**

Run: `rg -n "apps/web|@vibest/web" --glob '!node_modules' --glob '!pnpm-lock.yaml'`
Expected: no matches. (`pnpm-lock.yaml` will be regenerated in the next step.)

- [ ] **Step 5: Reinstall and typecheck**

Run: `pnpm install && pnpm typecheck`
Expected: install succeeds, typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename apps/web to apps/app"
```

---

## Task 2: Server auth — bearer token + ticket store

**Files:**

- Create: `packages/vibest/src/node/auth.ts`
- Create: `packages/vibest/src/node/auth.test.ts`
- Create: `packages/vibest/vitest.config.ts`
- Modify: `packages/vibest/package.json` (add `test` script + vitest devDependency)

**Interfaces:**

- Produces:
  - `bearerToken(header: string | undefined): string | null`
  - `tokensMatch(expected: string, actual: string | null): boolean`
  - `createTicketStore(now?: () => number): TicketStore` where `TicketStore = { issue(): string; consume(ticket: string | null): boolean }`
  - `TICKET_TTL_MS: number` (10_000)

- [ ] **Step 1: Add the test config and test script**

Create `packages/vibest/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

In `packages/vibest/package.json`, add to `scripts` (after `"start"`):

```json
    "test": "vitest run",
```

and add to `devDependencies`:

```json
    "vitest": "catalog:",
```

- [ ] **Step 2: Write the failing test**

Create `packages/vibest/src/node/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { bearerToken, createTicketStore, TICKET_TTL_MS, tokensMatch } from "./auth";

describe("bearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing header", () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(bearerToken("Basic abc123")).toBeNull();
  });

  it("returns null when the scheme has no value", () => {
    expect(bearerToken("Bearer")).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("accepts an exact match", () => {
    expect(tokensMatch("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(tokensMatch("s3cret", "s3crey")).toBe(false);
  });

  it("rejects a different length", () => {
    expect(tokensMatch("s3cret", "s3cre")).toBe(false);
  });

  it("rejects null", () => {
    expect(tokensMatch("s3cret", null)).toBe(false);
  });
});

describe("createTicketStore", () => {
  it("accepts a ticket it issued", () => {
    const store = createTicketStore();
    const ticket = store.issue();
    expect(store.consume(ticket)).toBe(true);
  });

  it("rejects the same ticket twice (single use)", () => {
    const store = createTicketStore();
    const ticket = store.issue();
    store.consume(ticket);
    expect(store.consume(ticket)).toBe(false);
  });

  it("rejects a ticket it never issued", () => {
    const store = createTicketStore();
    expect(store.consume("never-issued")).toBe(false);
  });

  it("rejects null", () => {
    const store = createTicketStore();
    expect(store.consume(null)).toBe(false);
  });

  it("rejects an expired ticket", () => {
    let now = 1_000;
    const store = createTicketStore(() => now);
    const ticket = store.issue();
    now += TICKET_TTL_MS + 1;
    expect(store.consume(ticket)).toBe(false);
  });

  it("issues distinct tickets", () => {
    const store = createTicketStore();
    expect(store.issue()).not.toBe(store.issue());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @vibest/cli test`
Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 4: Write the implementation**

Create `packages/vibest/src/node/auth.ts`:

```ts
import { randomUUID } from "node:crypto";

/** How long an issued WebSocket ticket stays redeemable. */
export const TICKET_TTL_MS = 10_000;

export type TicketStore = {
  /** Mint a ticket for one WebSocket upgrade. */
  issue(): string;
  /** Redeem a ticket. Always invalidates it, valid or not. */
  consume(ticket: string | null): boolean;
};

/**
 * Single-use, short-lived tickets for WebSocket upgrades. Browsers cannot set
 * headers on a WS handshake, so the bearer token cannot travel with it; the
 * renderer redeems a ticket fetched over the authenticated HTTP link instead.
 */
export function createTicketStore(now: () => number = Date.now): TicketStore {
  const expiries = new Map<string, number>();

  return {
    issue() {
      const ticket = randomUUID();
      expiries.set(ticket, now() + TICKET_TTL_MS);
      return ticket;
    },

    consume(ticket) {
      if (ticket === null) return false;
      const expiresAt = expiries.get(ticket);
      if (expiresAt === undefined) return false;
      // Delete before checking expiry: a ticket is spent by the attempt.
      expiries.delete(ticket);
      return expiresAt > now();
    },
  };
}

/** Pull the credential out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}

/** Length-then-XOR compare, so a match doesn't leak its prefix through timing. */
export function tokensMatch(expected: string, actual: string | null): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return diff === 0;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @vibest/cli test`
Expected: PASS — 15 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/vibest
git commit -m "feat(cli): add bearer-token auth and single-use WS ticket store"
```

---

## Task 3: Server CORS allowlist

**Files:**

- Create: `packages/vibest/src/node/cors.ts`
- Create: `packages/vibest/src/node/cors.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `corsHeaders(origin: string | undefined, allowed: readonly string[]): Record<string, string> | null`

- [ ] **Step 1: Write the failing test**

Create `packages/vibest/src/node/cors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { corsHeaders } from "./cors";

const ALLOWED = ["vibest://app", "http://localhost:5173"];

describe("corsHeaders", () => {
  it("allows an allowlisted origin", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers).not.toBeNull();
    expect(headers?.["access-control-allow-origin"]).toBe("vibest://app");
  });

  it("echoes the request origin rather than a wildcard", () => {
    const headers = corsHeaders("http://localhost:5173", ALLOWED);
    expect(headers?.["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("permits the Authorization header, which the renderer sends on every RPC call", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers?.["access-control-allow-headers"]).toContain("authorization");
  });

  it("varies on origin, so a shared cache cannot serve one origin's response to another", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers?.vary).toBe("origin");
  });

  it("rejects an origin that is not allowlisted", () => {
    expect(corsHeaders("https://evil.example", ALLOWED)).toBeNull();
  });

  it("returns null for a same-origin request, which sends no Origin header", () => {
    expect(corsHeaders(undefined, ALLOWED)).toBeNull();
  });

  it("returns null when nothing is allowlisted", () => {
    expect(corsHeaders("vibest://app", [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vibest/cli test`
Expected: FAIL — cannot resolve `./cors`.

- [ ] **Step 3: Write the implementation**

Create `packages/vibest/src/node/cors.ts`:

```ts
/**
 * Cross-origin headers for an allowlisted origin, or null to deny.
 *
 * The desktop renderer loads from `vibest://app` (or the Vite dev server in
 * dev) and calls the backend on `http://127.0.0.1:<port>` — a cross-origin
 * request. Browser mode is same-origin and sends no Origin header, so it never
 * reaches this path.
 */
export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vibest/cli test`
Expected: PASS — 7 new tests, 22 total.

- [ ] **Step 5: Commit**

```bash
git add packages/vibest
git commit -m "feat(cli): add CORS origin allowlist"
```

---

## Task 4: Wire auth, CORS, and the ticket endpoint into the server

**Files:**

- Modify: `packages/vibest/src/node/server.ts`
- Create: `packages/vibest/src/node/server.test.ts`

**Interfaces:**

- Consumes: `bearerToken`, `tokensMatch`, `createTicketStore` (Task 2); `corsHeaders` (Task 3).
- Produces: `createServer(options?: CreateServerOptions): Promise<Server>` where

```ts
export type CreateServerOptions = {
  /** When set, every /api/* request except /api/health requires `Authorization: Bearer <token>`, and every WS upgrade requires a valid `?ticket=`. */
  authToken?: string | undefined;
  /** Origins permitted to make cross-origin requests. Empty = same-origin only. */
  corsOrigins?: readonly string[] | undefined;
};
```

- New endpoint: `POST /api/ws-ticket` → `200 {"ticket":"<uuid>"}` (authenticated).

- [ ] **Step 1: Write the failing test**

Create `packages/vibest/src/node/server.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createServer } from "./server";

const TOKEN = "test-token-0000";

let server: Server | undefined;

async function start(options: Parameters<typeof createServer>[0]): Promise<string> {
  server = await createServer(options);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

describe("createServer auth", () => {
  it("serves /api/health without a token", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
  });

  it("rejects an unauthenticated /api/rpc call", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/rpc/whatever`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-000" },
    });
    expect(response.status).toBe(401);
  });

  it("issues a ticket to an authenticated caller", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ticket: string };
    expect(body.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires no token at all when none is configured (browser mode)", async () => {
    const base = await start({});
    const response = await fetch(`${base}/api/ws-ticket`, { method: "POST" });
    expect(response.status).toBe(200);
  });
});

describe("createServer CORS", () => {
  it("answers a preflight from an allowlisted origin", async () => {
    const base = await start({ authToken: TOKEN, corsOrigins: ["vibest://app"] });
    const response = await fetch(`${base}/api/rpc`, {
      method: "OPTIONS",
      headers: { origin: "vibest://app" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("vibest://app");
  });

  it("refuses a preflight from an unknown origin", async () => {
    const base = await start({ authToken: TOKEN, corsOrigins: ["vibest://app"] });
    const response = await fetch(`${base}/api/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("createServer WebSocket ticket", () => {
  async function connect(base: string, query: string): Promise<number> {
    const url = `${base.replace("http://", "ws://")}/ws/rpc${query}`;
    const socket = new WebSocket(url, "vibest");
    return await new Promise<number>((resolve) => {
      socket.on("open", () => {
        socket.close();
        resolve(200);
      });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("error", () => resolve(0));
    });
  }

  it("accepts an upgrade carrying a valid ticket", async () => {
    const base = await start({ authToken: TOKEN });
    const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    expect(await connect(base, `?ticket=${ticket}`)).toBe(200);
  });

  it("rejects an upgrade with no ticket", async () => {
    const base = await start({ authToken: TOKEN });
    expect(await connect(base, "")).toBe(401);
  });

  it("rejects a replayed ticket", async () => {
    const base = await start({ authToken: TOKEN });
    const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    await connect(base, `?ticket=${ticket}`);
    expect(await connect(base, `?ticket=${ticket}`)).toBe(401);
  });

  it("accepts an upgrade with no ticket when no token is configured (browser mode)", async () => {
    const base = await start({});
    expect(await connect(base, "")).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vibest/cli test`
Expected: FAIL — `createServer` takes no arguments; `/api/ws-ticket` 404s.

- [ ] **Step 3: Rewrite the server**

Replace the whole of `packages/vibest/src/node/server.ts` with:

```ts
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeRPCHandler, createWsRPCHandler } from "@vibest/server/rpc";
import sirv from "sirv";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { bearerToken, createTicketStore, tokensMatch } from "./auth";
import { corsHeaders } from "./cors";

const isDev = process.env.NODE_ENV === "development";

type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

export type CreateServerOptions = {
  /**
   * When set, every `/api/*` request except `/api/health` must present
   * `Authorization: Bearer <token>`, and every WebSocket upgrade must carry a
   * valid single-use `?ticket=`. Unset (browser mode) disables both.
   */
  authToken?: string | undefined;
  /** Origins permitted to make cross-origin requests. Empty = same-origin only. */
  corsOrigins?: readonly string[] | undefined;
};

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    new URL("./client/", import.meta.url), // packaged: dist/client next to dist/cli.js
    new URL("../../../../apps/app/dist/", import.meta.url), // monorepo, from src/node
    new URL("../../../apps/app/dist/", import.meta.url), // monorepo, from packages/vibest/dist
  ];
  for (const candidate of candidates) {
    const dir = path.resolve(fileURLToPath(candidate));
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}

export async function createServer(options: CreateServerOptions = {}): Promise<Server> {
  const { authToken, corsOrigins = [] } = options;

  const rpcHandler = createNodeRPCHandler();
  const wsHandler = createWsRPCHandler();
  const tickets = createTicketStore();

  let serveUI: UIHandler;

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const headers = corsHeaders(req.headers.origin, corsOrigins);
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          res.setHeader(name, value);
        }
      }

      if (req.method === "OPTIONS") {
        // A preflight from an origin we don't allow gets no headers, so the
        // browser blocks the real request that would have followed.
        res.statusCode = headers ? 204 : 403;
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      // Unauthenticated on purpose: the desktop supervisor polls this before
      // it holds a token, and it discloses nothing.
      if (req.method === "GET" && pathname === "/api/health") {
        res.setHeader("content-type", "text/plain");
        res.end("ok");
        return;
      }

      if (authToken !== undefined && pathname.startsWith("/api/")) {
        if (!tokensMatch(authToken, bearerToken(req.headers.authorization))) {
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/ws-ticket") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ticket: tickets.issue() }));
        return;
      }

      if (pathname === "/api/rpc" || pathname.startsWith("/api/rpc/")) {
        const { matched } = await rpcHandler(req, res, {
          prefix: "/api/rpc",
        });
        if (matched) {
          return;
        }
      }

      serveUI(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    }
  }

  if (isDev) {
    // Import vite lazily so the production bundle never depends on it
    // (vite is a devDependency and marked external in tsdown.config.ts).
    const { createServer: createViteDevServer } = await import("vite");
    const vite = await createViteDevServer({
      // Serve the standalone web app package (apps/app) through this server.
      root: path.resolve(fileURLToPath(new URL("../../../../apps/app/", import.meta.url))),
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
    });
    serveUI = (req, res) => vite.middlewares(req, res, () => notFound(res));
  } else {
    const staticDir = resolveStaticDir();
    if (!staticDir) {
      serveUI = (_req, res) => {
        res.statusCode = 503;
        res.end("Web UI not built. Run the @vibest/app build first.");
      };
    } else {
      const assets = sirv(staticDir, {
        single: true,
      });
      serveUI = (req, res) => assets(req, res, () => notFound(res));
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsHandler(ws);
  });
  wss.on("error", (e: Error & { code: string; port: number }) => {
    console.error(e);
  });

  // Share the same HTTP server between Vite's HMR socket and our custom WebSocketServer.
  server.on("upgrade", (req, socket, head) => {
    if (isDev) {
      const protocol = req.headers["sec-websocket-protocol"];
      if (protocol && ["vite-ping", "vite-hmr"].includes(protocol)) return;
    }

    if (authToken !== undefined) {
      // A WS handshake carries no Authorization header, so the renderer proves
      // itself with a single-use ticket minted over the authenticated HTTP link.
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (!tickets.consume(requestUrl.searchParams.get("ticket"))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });

  return server;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vibest/cli test`
Expected: PASS — 11 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/vibest
git commit -m "feat(cli): enforce bearer auth, CORS, and ticketed WS upgrades"
```

---

## Task 5: CLI — env config, token scrub, dynamic port, ready handshake

**Files:**

- Create: `packages/vibest/src/node/handshake.ts`
- Create: `packages/vibest/src/node/handshake.test.ts`
- Modify: `packages/vibest/src/node/cli.ts`
- Modify: `packages/vibest/package.json` (add an `exports` map)

**Interfaces:**

- Consumes: `createServer(options)` (Task 4).
- Produces:
  - `READY_PREFIX: string` (`"vibest:ready "`)
  - `formatReadyLine(info: ReadyInfo): string`
  - `parseReadyLine(line: string): ReadyInfo | null` where `ReadyInfo = { port: number }`
  - Package subpath export `@vibest/cli/handshake` → `./src/node/handshake.ts` (imported by `apps/desktop`'s main process, which electron-vite bundles from TypeScript source).
  - Env contract read by the CLI: `VIBEST_AUTH_TOKEN`, `VIBEST_CORS_ORIGINS` (comma-separated), `VIBEST_PORT` (default `4000`; `0` = OS-assigned).

- [ ] **Step 1: Write the failing test**

Create `packages/vibest/src/node/handshake.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatReadyLine, parseReadyLine, READY_PREFIX } from "./handshake";

describe("ready line", () => {
  it("round-trips the bound port", () => {
    const line = formatReadyLine({ port: 41234 });
    expect(parseReadyLine(line)).toEqual({ port: 41234 });
  });

  it("is prefixed so it can be picked out of ordinary stdout", () => {
    expect(formatReadyLine({ port: 1 }).startsWith(READY_PREFIX)).toBe(true);
  });

  it("ignores an unrelated log line", () => {
    expect(parseReadyLine("vibest listening on http://127.0.0.1:4000")).toBeNull();
  });

  it("ignores a prefixed line with unparseable JSON", () => {
    expect(parseReadyLine(`${READY_PREFIX}not-json`)).toBeNull();
  });

  it("ignores a prefixed line with no numeric port", () => {
    expect(parseReadyLine(`${READY_PREFIX}{"port":"nope"}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vibest/cli test`
Expected: FAIL — cannot resolve `./handshake`.

- [ ] **Step 3: Write the handshake module**

Create `packages/vibest/src/node/handshake.ts`:

```ts
/**
 * The server's startup handshake. It binds to an OS-assigned port when asked
 * to, so it must tell its parent which port it actually got. One prefixed JSON
 * line on stdout, so a supervisor can pick it out of ordinary logging.
 */
export const READY_PREFIX = "vibest:ready ";

export type ReadyInfo = {
  port: number;
};

export function formatReadyLine(info: ReadyInfo): string {
  return `${READY_PREFIX}${JSON.stringify(info)}`;
}

export function parseReadyLine(line: string): ReadyInfo | null {
  if (!line.startsWith(READY_PREFIX)) return null;

  try {
    const parsed: unknown = JSON.parse(line.slice(READY_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { port } = parsed as { port?: unknown };
    if (typeof port !== "number" || !Number.isInteger(port)) return null;
    return { port };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rewrite the CLI entry**

Replace the whole of `packages/vibest/src/node/cli.ts` with:

```ts
#!/usr/bin/env node

import type { AddressInfo } from "node:net";

import { formatReadyLine } from "./handshake";
import { createServer } from "./server";

const DEFAULT_PORT = 4000;

/**
 * Read the token, then scrub it. The agent spawns a shell for every tool call
 * and children inherit this environment — an agent-run command must not be
 * able to read the credential that guards the agent.
 */
function takeAuthToken(): string | undefined {
  const token = process.env.VIBEST_AUTH_TOKEN;
  delete process.env.VIBEST_AUTH_TOKEN;
  return token;
}

function readCorsOrigins(): string[] {
  return (process.env.VIBEST_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function readPort(): number {
  const raw = process.env.VIBEST_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

async function main() {
  const authToken = takeAuthToken();
  const server = await createServer({ authToken, corsOrigins: readCorsOrigins() });

  server.listen(readPort(), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    // Machine-readable first, for the desktop supervisor; human-readable second.
    console.log(formatReadyLine({ port }));
    console.log(`vibest listening on http://127.0.0.1:${port}`);
  });
}

main();
```

- [ ] **Step 5: Export the handshake as a subpath**

In `packages/vibest/package.json`, add an `exports` map immediately after the `bin` field. The desktop main process imports this; electron-vite bundles it straight from TypeScript source, matching how the rest of the workspace resolves types from `src`.

```json
  "exports": {
    "./handshake": "./src/node/handshake.ts"
  },
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @vibest/cli test && pnpm --filter @vibest/cli typecheck`
Expected: PASS — 5 new tests; typecheck clean.

- [ ] **Step 7: Verify the ready line end to end**

Run: `pnpm --filter @vibest/cli build && VIBEST_PORT=0 node packages/vibest/dist/cli.mjs`
Expected: first stdout line matches `vibest:ready {"port":<some port>}` with a non-zero port; second line is the human-readable URL. Stop it with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add packages/vibest
git commit -m "feat(cli): configure via env, scrub token, bind dynamic port, emit ready line"
```

---

## Task 6: Client — auth headers and WS tickets

**Files:**

- Modify: `packages/client/src/index.ts`

**Interfaces:**

- Produces:
  - `createVibestClient(options?: { url?: FetchLinkUrl; headers?: Record<string, string> }): VibestClient`
  - `createVibestWsClient(options?: { url?: string | URL; protocols?: string | string[]; getTicket?: () => Promise<string> }): VibestClient`

**Background the implementer needs:** oRPC `2.0.0-beta.16` types the WebSocket link's `connect` as `(info) => Promisable<WebSocketLike>` — it may be async, and it is re-invoked on every reconnect attempt. That is what makes a _single-use_ ticket workable: each reconnect mints a fresh one.

- [ ] **Step 1: Write the failing test**

The behaviour worth pinning here is the ticket handshake: every connect attempt must mint a _fresh_ ticket (a stale one is already spent), and the socket must not be opened — nor a ticket burned — until something actually calls. Test that by driving `connect` directly.

Create `packages/client/src/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createWsConnect } from "./index";

describe("createWsConnect", () => {
  it("does not fetch a ticket until a connection is attempted", () => {
    const getTicket = vi.fn(async () => "ticket-1");

    createWsConnect({ url: "ws://127.0.0.1:4100/ws/rpc", getTicket });

    expect(getTicket).not.toHaveBeenCalled();
  });

  it("appends the fetched ticket to the socket URL", async () => {
    const opened: string[] = [];
    class FakeSocket {
      constructor(url: string | URL) {
        opened.push(url.toString());
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const connect = createWsConnect({
      url: "ws://127.0.0.1:4100/ws/rpc",
      getTicket: async () => "ticket-1",
    });
    await connect();

    expect(opened).toEqual(["ws://127.0.0.1:4100/ws/rpc?ticket=ticket-1"]);
    vi.unstubAllGlobals();
  });

  it("mints a fresh ticket on every reconnect, since a ticket is single-use", async () => {
    const opened: string[] = [];
    class FakeSocket {
      constructor(url: string | URL) {
        opened.push(url.toString());
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    let issued = 0;
    const connect = createWsConnect({
      url: "ws://127.0.0.1:4100/ws/rpc",
      getTicket: async () => {
        issued += 1;
        return `ticket-${issued}`;
      },
    });
    await connect();
    await connect();

    expect(opened).toEqual([
      "ws://127.0.0.1:4100/ws/rpc?ticket=ticket-1",
      "ws://127.0.0.1:4100/ws/rpc?ticket=ticket-2",
    ]);
    vi.unstubAllGlobals();
  });

  it("opens the bare URL when no ticket is required (browser mode)", async () => {
    const opened: string[] = [];
    class FakeSocket {
      constructor(url: string | URL) {
        opened.push(url.toString());
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const connect = createWsConnect({ url: "ws://127.0.0.1:4100/ws/rpc" });
    await connect();

    expect(opened).toEqual(["ws://127.0.0.1:4100/ws/rpc"]);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Add a vitest config and test script to `packages/client`**

Create `packages/client/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

In `packages/client/package.json`, add to `scripts`:

```json
    "test": "vitest run",
```

and to `devDependencies`:

```json
    "vitest": "catalog:",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @vibest/client test`
Expected: FAIL — `createWsConnect` is not exported.

- [ ] **Step 4: Write the implementation**

Replace the whole of `packages/client/src/index.ts` with:

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterContractClient } from "@orpc/contract";
import type { Contract } from "@vibest/contract";

/** A fully typed client for the Vibest server, derived from the contract. */
export type VibestClient = RouterContractClient<Contract>;

type FetchLinkUrl = NonNullable<ConstructorParameters<typeof RPCLink>[0]>["url"];

export type CreateVibestClientOptions = {
  /**
   * RPC endpoint. Defaults to the relative `/api/rpc` — clients served
   * same-origin by the CLI server need no configuration. The desktop renderer
   * loads from a custom protocol, so it passes the backend's absolute origin.
   */
  url?: FetchLinkUrl;
  /**
   * Headers sent with every call. The desktop renderer passes the per-launch
   * bearer token here; browser mode is same-origin and needs none.
   */
  headers?: Record<string, string>;
};

/** HTTP client (fetch link). One request per call; streams over SSE. */
export function createVibestClient(options: CreateVibestClientOptions = {}): VibestClient {
  const link = new RPCLink({
    url: options.url ?? "/api/rpc",
    ...(options.headers ? { headers: options.headers } : {}),
  });
  return createORPCClient(link);
}

export type CreateVibestWsClientOptions = {
  /** WebSocket endpoint. Defaults to `/ws/rpc` on the current origin. */
  url?: string | URL;
  /** WebSocket subprotocol; the CLI server upgrades on "vibest". */
  protocols?: string | string[];
  /**
   * Mint a single-use ticket for the handshake. A browser cannot set headers on
   * a WebSocket upgrade, so the bearer token can't travel with it; the desktop
   * renderer fetches a ticket over the authenticated HTTP link instead. The
   * link re-invokes `connect` on every reconnect, so each attempt gets a fresh
   * ticket. Omitted in browser mode, where the server requires none.
   */
  getTicket?: () => Promise<string>;
};

function defaultWsUrl(): URL {
  const url = new URL("/ws/rpc", globalThis.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * The link's `connect` factory. Exported so the ticket handshake is testable
 * without standing up a socket server.
 */
export function createWsConnect(options: CreateVibestWsClientOptions): () => Promise<WebSocket> {
  return async () => {
    const url = new URL(options.url ?? defaultWsUrl());
    if (options.getTicket) {
      url.searchParams.set("ticket", await options.getTicket());
    }
    return new WebSocket(url, options.protocols ?? "vibest");
  };
}

/**
 * WebSocket client: every call multiplexed over one connection. The link takes
 * a lazy `connect` factory (oRPC 2.0.0-beta.16), so the socket is only opened
 * on first use — and re-opened, with a fresh ticket, on every reconnect.
 */
export function createVibestWsClient(options: CreateVibestWsClientOptions = {}): VibestClient {
  const link = new WebSocketRPCLink({
    connect: createWsConnect(options),
  });
  return createORPCClient(link);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @vibest/client test && pnpm --filter @vibest/client typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): support auth headers and ticketed WebSocket connects"
```

---

## Task 7: `apps/app` — the Platform seam

**Files:**

- Create: `apps/app/src/platform.ts`
- Modify: `apps/app/src/lib/orpc.ts`
- Modify: `apps/app/src/router.tsx`
- Modify: `apps/app/src/routes/__root.tsx`
- Modify: `apps/app/src/core/chat/chat-transport.ts`
- Modify: `apps/app/src/core/chat/chat-manager.ts`
- Modify: `apps/app/src/core/chat/chat-context.tsx`
- Create: `apps/app/src/app.tsx`
- Modify: `apps/app/src/main.tsx`

**Interfaces:**

- Consumes: `createVibestClient({ url, headers })`, `createVibestWsClient({ url, getTicket })` (Task 6).
- Produces:
  - `Platform` (`apps/app/src/platform.ts`) — `{ host: "web" } | { host: "desktop"; os: string; backend: BackendConnection }`
  - `BackendConnection` — `{ httpBaseUrl: string; wsBaseUrl: string; token: string }`
  - `createAppClients(platform: Platform): AppClients` (`apps/app/src/lib/orpc.ts`)
  - `AppClients` — `{ queryClient: QueryClient; orpcClient: VibestClient; orpcWsClient: VibestClient; orpc: OrpcUtils }`
  - `createApp(platform: Platform): ReactElement` (`apps/app/src/app.tsx`)
  - `createRouter(clients: AppClients)` (`apps/app/src/router.tsx`) — now takes an argument
  - `new ChatTransport(clients)` — now takes an argument
  - `useChatManager()` now throws if no `ChatManagerProvider` is above it

**Why this shape:** each host entry point constructs exactly one `Platform` and passes it in. No module ever asks "am I in Electron?" — the compiler decides. This is the seam a native folder-picker will slot into (`{ host: "desktop"; ...; openDirectoryPicker(): Promise<string | null> }`), which is why the union exists before there's a second desktop-only capability to put in it.

- [ ] **Step 1: Create the Platform type**

Create `apps/app/src/platform.ts`:

```ts
/** Where the desktop shell's spawned backend is listening, and how to talk to it. */
export type BackendConnection = {
  /** e.g. "http://127.0.0.1:41234" */
  httpBaseUrl: string;
  /** e.g. "ws://127.0.0.1:41234" */
  wsBaseUrl: string;
  /** Per-launch bearer token. Never persisted. */
  token: string;
};

/**
 * The host this UI is running in, injected by the entry point — never sniffed
 * at runtime. Browser mode is same-origin and needs no connection details; the
 * Electron renderer loads from `vibest://app` and must be told where its
 * backend is. Desktop-only capabilities (a native directory picker, for one)
 * belong on the `desktop` arm, where the compiler keeps web code away from them.
 */
export type Platform =
  { host: "web" } | { host: "desktop"; os: string; backend: BackendConnection };
```

- [ ] **Step 2: Turn the client singletons into a factory**

Replace the whole of `apps/app/src/lib/orpc.ts` with:

```ts
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createVibestClient, createVibestWsClient, type VibestClient } from "@vibest/client";
import { toast } from "sonner";

import type { Platform } from "@/platform";

export type AppClients = {
  queryClient: QueryClient;
  orpcClient: VibestClient;
  orpcWsClient: VibestClient;
  orpc: ReturnType<typeof createTanstackQueryUtils<VibestClient>>;
};

function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        toast.error(`Error: ${error.message}`, {
          action: {
            label: "retry",
            onClick: () => {
              queryClient.invalidateQueries();
            },
          },
        });
      },
    }),
  });
  return queryClient;
}

/**
 * Build the RPC clients for a host. Browser mode is same-origin, so the
 * defaults (relative `/api/rpc`, origin-derived `/ws/rpc`) are correct and no
 * credential is needed. The desktop renderer's origin is `vibest://app` while
 * its backend is on loopback, so every call is cross-origin and authenticated.
 */
export function createAppClients(platform: Platform): AppClients {
  const queryClient = createQueryClient();

  if (platform.host === "web") {
    const orpcClient = createVibestClient();
    const orpcWsClient = createVibestWsClient();
    return {
      queryClient,
      orpcClient,
      orpcWsClient,
      orpc: createTanstackQueryUtils(orpcClient),
    };
  }

  const { httpBaseUrl, wsBaseUrl, token } = platform.backend;
  const headers = { authorization: `Bearer ${token}` };

  // oRPC's fetch link takes a ROOT-RELATIVE `url` plus a separate absolute
  // `origin` — an absolute `url` does not typecheck. `createVibestClient`
  // exposes `origin` as a passthrough for exactly this.
  const orpcClient = createVibestClient({ origin: httpBaseUrl, headers });
  const orpcWsClient = createVibestWsClient({
    url: `${wsBaseUrl}/ws/rpc`,
    getTicket: async () => {
      const response = await fetch(`${httpBaseUrl}/api/ws-ticket`, { method: "POST", headers });
      if (!response.ok) {
        throw new Error(`Failed to obtain a WebSocket ticket: ${response.status}`);
      }
      const body = (await response.json()) as { ticket: string };
      return body.ticket;
    },
  });

  return { queryClient, orpcClient, orpcWsClient, orpc: createTanstackQueryUtils(orpcClient) };
}
```

- [ ] **Step 3: Make the router take its clients**

Replace the whole of `apps/app/src/router.tsx` with:

```tsx
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import Loader from "./components/loader";
import type { AppClients } from "./lib/orpc";
import { routeTree } from "./routeTree.gen";

export const createRouter = (clients: AppClients) => {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: { orpc: clients.orpc, queryClient: clients.queryClient },
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <div>Not Found</div>,
  });
  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
```

- [ ] **Step 4: Fix the root route's context type**

`apps/app/src/routes/__root.tsx` types `orpc` as `typeof orpc` — an import of the now-deleted singleton. Change the import and the interface:

```tsx
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouterState } from "@tanstack/react-router";

import Loader from "@/components/loader";
import type { AppClients } from "@/lib/orpc";

export interface RouterAppContext {
  orpc: AppClients["orpc"];
  queryClient: QueryClient;
}
```

Leave the rest of the file (`Route`, `RootLayout`) unchanged.

- [ ] **Step 5: Inject the clients into ChatTransport**

In `apps/app/src/core/chat/chat-transport.ts`, replace the module-scope import of the singletons with a constructor parameter. Change the import block:

```ts
import { consumeEventIterator, eventIteratorToStream } from "@orpc/client";
import type { ToolPermissionRequest } from "@vibest/contract/claude-code";
import type { ChatTransport as AiChatTransport, UIMessage, UIMessageChunk } from "ai";

import type { AppClients } from "@/lib/orpc";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import { isAutoAllowed, toAgentRequest, toPermissionResult } from "./providers/claude-code/request";
```

Add the constructor to the class (immediately after the `#rawRequests` field):

```ts
export class ChatTransport implements AiChatTransport<UIMessage> {
  #rawRequests = new Map<string, ToolPermissionRequest>();

  constructor(private readonly clients: Pick<AppClients, "orpcClient" | "orpcWsClient">) {}
```

Then replace every bare `orpcClient.` with `this.clients.orpcClient.` and every bare `orpcWsClient.` with `this.clients.orpcWsClient.` in the file. There are four such references: one `orpcClient.claudeCode.prompt` in `sendMessages`, and three `orpcWsClient.claudeCode.*` (`requestPermission` and `respondPermission` in `subscribeAgentRequests`, `respondPermission` in `respondToAgentRequest`).

- [ ] **Step 6: Drop the ChatManager module singleton**

Replace the tail of `apps/app/src/core/chat/chat-manager.ts` — delete the `globalKey` / `chatManager` block entirely. The file now ends after the `ChatManager` class:

```ts
import { Chat } from "./chat";
import type { ChatTransport } from "./chat-transport";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  attach(sessionId: string): Chat;
}

// Owns the live Chat instances keyed by sessionId. Sessions survive route
// switches: attach() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount.
// Constructed once per host entry point (see createApp), not at module scope:
// a module-level `new` cannot see the Platform the entry chose.
export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly transport: ChatTransport) {}

  attach(sessionId: string): Chat {
    const existing = this.#chats.get(sessionId);
    if (existing) return existing;
    const chat = new Chat({ sessionId, transport: this.transport });
    this.#chats.set(sessionId, chat);
    return chat;
  }
}
```

- [ ] **Step 7: Require the provider**

Replace the whole of `apps/app/src/core/chat/chat-context.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { ChatManagerApi } from "./chat-manager";

// Consumers only see the narrow ChatManagerApi (not the ChatManager class).
// There is no default: the manager is built by the host entry point, so a
// missing provider is a wiring bug, not something to paper over with a
// second, silently-unshared instance.
const ChatManagerContext = createContext<ChatManagerApi | null>(null);

export function ChatManagerProvider({
  manager,
  children,
}: {
  manager: ChatManagerApi;
  children: ReactNode;
}) {
  return <ChatManagerContext.Provider value={manager}>{children}</ChatManagerContext.Provider>;
}

export function useChatManager(): ChatManagerApi {
  const manager = useContext(ChatManagerContext);
  if (!manager) {
    throw new Error("useChatManager must be used within a ChatManagerProvider");
  }
  return manager;
}
```

- [ ] **Step 8: Create the shared app factory**

Create `apps/app/src/app.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, type ReactElement } from "react";

import { ChatManagerProvider } from "./core/chat/chat-context";
import { ChatManager } from "./core/chat/chat-manager";
import { ChatTransport } from "./core/chat/chat-transport";
import { createAppClients } from "./lib/orpc";
import type { Platform } from "./platform";
import { createRouter } from "./router";

/**
 * The whole UI, parameterised by its host. Both entry points — the browser's
 * `main.tsx` and the Electron renderer's — call this with the Platform they
 * constructed, and render the result.
 */
export function createApp(platform: Platform): ReactElement {
  const clients = createAppClients(platform);
  const router = createRouter(clients);
  const chatManager = new ChatManager(new ChatTransport(clients));

  return (
    <StrictMode>
      <QueryClientProvider client={clients.queryClient}>
        <ChatManagerProvider manager={chatManager}>
          <RouterProvider router={router} />
        </ChatManagerProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
```

- [ ] **Step 9: Slim the web entry**

Replace the whole of `apps/app/src/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";

import { createApp } from "./app";

import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(createApp({ host: "web" }));
```

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @vibest/app typecheck`
Expected: PASS. If anything still imports `orpcClient`, `orpcWsClient`, `queryClient`, `orpc`, or `chatManager` from `@/lib/orpc` or `./chat-manager`, fix it to take the value from `AppClients` / the provider — those module-scope exports are gone.

- [ ] **Step 11: Verify browser mode still works**

Run: `pnpm --filter @vibest/cli build && pnpm --filter @vibest/app build && node packages/vibest/dist/cli.mjs`
Then open `http://127.0.0.1:4000` in a browser.
Expected: the chat UI loads, with no console errors about RPC or WebSocket.
Stop the server with Ctrl-C.

- [ ] **Step 12: Commit**

```bash
git add apps/app
git commit -m "refactor(app): inject host capabilities via a Platform union"
```

---

## Task 8: `apps/app` — share the Vite config with the desktop renderer

**Files:**

- Create: `apps/app/vite.shared.ts`
- Modify: `apps/app/vite.config.ts`
- Modify: `apps/app/package.json` (exports map)

**Interfaces:**

- Produces:
  - `appVitePlugins(): PluginOption[]` and `appAlias(): Record<string, string>` (`apps/app/vite.shared.ts`)
  - Package subpath exports on `@vibest/app`: `./app`, `./platform`, `./vite`, `./index.css`

**Why:** the desktop renderer compiles `apps/app`'s source itself (it is _not_ a copy of `apps/app/dist`). For that to work, `apps/desktop`'s electron-vite renderer config must apply the same plugins — TanStack Router codegen, React, Tailwind — and the same `@` alias. Sharing one module keeps them from drifting. This mirrors opencode, whose `packages/desktop` imports `@opencode-ai/app/vite`.

- [ ] **Step 1: Extract the shared config**

Create `apps/app/vite.shared.ts`:

```ts
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import type { PluginOption } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/**
 * The `@` alias, resolved absolutely. The desktop renderer builds this app's
 * source from another package's directory, so a relative alias would break.
 */
export function appAlias(): Record<string, string> {
  return { "@": srcDir };
}

/**
 * Every plugin the app's source needs to compile. Shared by this package's own
 * Vite config and by apps/desktop's electron-vite renderer config, which
 * compiles the same source into the Electron bundle.
 */
export function appVitePlugins(): PluginOption[] {
  return [
    codeInspectorPlugin({ bundler: "vite" }),
    // The TanStack Router plugin must come before JSX transform plugins.
    tanstackRouter({
      target: "react",
      verboseFileRoutes: false,
      autoCodeSplitting: true,
      // Absolute paths: consumers (apps/desktop, and tools like oxfmt/oxlint)
      // load this config with a different cwd, where plugin-relative paths
      // would resolve incorrectly.
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ];
}
```

- [ ] **Step 2: Reduce the app's own Vite config to a consumer of it**

Replace the whole of `apps/app/vite.config.ts`:

```ts
import { defineConfig } from "vite";

import { appAlias, appVitePlugins } from "./vite.shared";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: appAlias(),
  },
  plugins: appVitePlugins(),
});
```

- [ ] **Step 3: Export the subpaths the desktop renderer imports**

In `apps/app/package.json`, add an `exports` map immediately after `"type": "module"`:

```json
  "exports": {
    "./app": "./src/app.tsx",
    "./platform": "./src/platform.ts",
    "./vite": "./vite.shared.ts",
    "./index.css": "./src/index.css"
  },
```

- [ ] **Step 4: Verify the web build still works**

Run: `pnpm --filter @vibest/app build`
Expected: PASS — `apps/app/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "refactor(app): share vite plugins and alias with desktop renderer"
```

---

## Task 9: Gut the obsolete desktop app

**Files:**

- Delete: `apps/desktop/src/renderer/src/` (whole tree)
- Delete: `apps/desktop/src/main/app.ts`, `apps/desktop/src/main/services/`, `apps/desktop/src/main/terminal/`, `apps/desktop/src/main/ipc/`, `apps/desktop/src/main/infra/`
- Delete: `apps/desktop/src/shared/contract/`, `apps/desktop/src/shared/types.ts`, `apps/desktop/src/shared/index.ts`
- Delete: `apps/desktop/e2e/tests/app.spec.ts`, `apps/desktop/e2e/tests/screenshots.spec.ts`
- Modify: `apps/desktop/src/main/index.ts` (strip the `App` wiring)
- Modify: `apps/desktop/package.json` (drop dead dependencies)

**Interfaces:**

- Produces: an `apps/desktop` that builds and launches to an empty window — the shell, with nothing in it yet. Tasks 10–13 fill it.

**Note:** `packages/services` is deliberately left in the workspace, unreferenced (it holds the git/worktree/terminal services this app used). Do not delete that package. Only the `apps/desktop` dependency on it goes.

- [ ] **Step 1: Delete the obsolete trees**

```bash
git rm -r apps/desktop/src/renderer/src
git rm -r apps/desktop/src/main/services apps/desktop/src/main/terminal apps/desktop/src/main/ipc apps/desktop/src/main/infra
git rm apps/desktop/src/main/app.ts
git rm -r apps/desktop/src/shared
git rm apps/desktop/e2e/tests/app.spec.ts apps/desktop/e2e/tests/screenshots.spec.ts
```

- [ ] **Step 2: Strip the main process down to a bare shell**

Replace the whole of `apps/desktop/src/main/index.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, shell } from "electron";

import icon from "../../resources/icon.png?asset";

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      // .js, not .mjs: a sandboxed preload must be CommonJS — Electron does not
      // support ESM preloads in a sandboxed renderer. Step 5 configures
      // electron-vite to emit it that way.
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.js"),
      // Nothing in the renderer needs Node any more — the backend is a separate
      // process, reached over HTTP.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.vibest.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

The window has nothing to load yet; Task 12 adds that.

- [ ] **Step 3: Drop the dead dependencies**

In `apps/desktop/package.json`, remove these entries from `dependencies`:

```
"@xterm/addon-web-links", "electron-store", "node-pty", "simple-git"
```

and these from `devDependencies`:

```
"@orpc/publisher", "@orpc/server", "@pierre/diffs", "@vibest/services",
"@xterm/addon-fit", "@xterm/addon-serialize", "@xterm/addon-webgl",
"@xterm/headless", "@xterm/xterm"
```

Leave `@orpc/client`, `@orpc/contract`, `@orpc/tanstack-query`, `@tanstack/react-query`, `@vibest/ui`, React, Tailwind, electron, electron-builder, electron-vite, and Playwright in place — the new renderer needs them.

- [ ] **Step 4: Remove the node-pty external from the build config**

In `apps/desktop/electron.vite.config.ts`, delete the now-meaningless `rollupOptions.external` from the `main` block, leaving:

```ts
  main: {
    build: {
      outDir: "dist/main",
    },
  },
```

- [ ] **Step 5: Emit the preload as CommonJS**

The window now sets `sandbox: true`, and **Electron does not support ESM preload scripts in a sandboxed renderer** — the preload must be CommonJS. electron-vite emits `.mjs` by default, so override it. (This is exactly what opencode does: `format: "cjs"`, `entryFileNames: "[name].js"`, loaded as `../preload/index.js`.)

In `apps/desktop/electron.vite.config.ts`, replace the `preload` block:

```ts
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
```

- [ ] **Step 6: Remove the node-pty asarUnpack rule**

In `apps/desktop/electron-builder.yml`, change `asarUnpack` to drop the node-pty line:

```yaml
asarUnpack:
  - resources/**
```

- [ ] **Step 7: Fix the tsconfigs**

`apps/desktop/tsconfig.node.json` — remove the deleted `src/shared` from `include`:

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["electron.vite.config.*", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "types": ["electron-vite/node"]
  }
}
```

Leave this file as-is — `src/shared` is recreated in Task 11 (`src/shared/bridge.ts`), so the glob stays valid.

`apps/desktop/tsconfig.web.json` — the renderer moves from `src/renderer/src/**` to `src/renderer/**`, and the `@renderer` alias is gone. Replace the file:

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": ["src/renderer/**/*", "src/preload/*.d.ts", "src/shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 8: Reinstall and confirm it still builds**

Run: `pnpm install && pnpm --filter desktop exec electron-vite build`
Expected: the main and preload bundles build. The renderer build fails — `src/renderer/index.html` still points at the deleted `src/main.tsx`. That is expected; Task 12 replaces it. Do not fix it here.

- [ ] **Step 9: Commit**

```bash
git add -A apps/desktop
git commit -m "refactor(desktop): remove worktree/task/terminal app, leaving the shell"
```

---

## Task 10: Desktop — backend supervisor

**Files:**

- Create: `apps/desktop/src/main/backend.ts`
- Create: `apps/desktop/src/main/backend.test.ts`
- Modify: `apps/desktop/package.json` (add `@vibest/cli` dependency)

**Interfaces:**

- Consumes: `READY_PREFIX`, `parseReadyLine` from `@vibest/cli/handshake` (Task 5); the env contract `VIBEST_AUTH_TOKEN` / `VIBEST_CORS_ORIGINS` / `VIBEST_PORT` (Task 5).
- Produces:
  - `startBackend(options: StartBackendOptions): Promise<Backend>` where
    ```ts
    export type StartBackendOptions = { corsOrigins: readonly string[] };
    export type Backend = {
      httpBaseUrl: string;
      wsBaseUrl: string;
      token: string;
      stop(): void;
    };
    ```
  - `resolveServerEntry(isPackaged: boolean, resourcesPath: string): string` — exported for test.

**Why `process.execPath` + `ELECTRON_RUN_AS_NODE`:** a packaged app cannot assume the user has Node installed. Electron ships a Node runtime; running its own binary in Node mode uses it. This is t3code's `DesktopBackendConfiguration.ts` approach.

- [ ] **Step 1: Add the dependency**

In `apps/desktop/package.json`, add to `dependencies`:

```json
    "@vibest/cli": "workspace:*",
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/backend.test.ts`:

```ts
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveServerEntry } from "./backend";

describe("resolveServerEntry", () => {
  it("points at the bundled server in a packaged app", () => {
    const entry = resolveServerEntry(true, "/Applications/Vibest.app/Contents/Resources");
    expect(entry).toBe(
      path.join("/Applications/Vibest.app/Contents/Resources", "server", "cli.mjs"),
    );
  });

  it("points at the monorepo build when unpackaged", () => {
    const entry = resolveServerEntry(false, "/unused");
    expect(entry).toMatch(/packages[/\\]vibest[/\\]dist[/\\]cli\.mjs$/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter desktop test`
Expected: FAIL — cannot resolve `./backend`.

- [ ] **Step 4: Write the supervisor**

Create `apps/desktop/src/main/backend.ts`:

```ts
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseReadyLine } from "@vibest/cli/handshake";
import { app } from "electron";

const START_TIMEOUT_MS = 30_000;

export type StartBackendOptions = {
  /** Origins the renderer will call from: the app protocol, and the dev server. */
  corsOrigins: readonly string[];
};

export type Backend = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  /** Per-launch bearer token. Held in memory only. */
  token: string;
  stop(): void;
};

/**
 * Where the server bundle lives. Packaged builds ship it as an extraResource
 * (outside the asar, so it is a real file on disk that Node can execute);
 * unpackaged runs use the monorepo's build output.
 */
export function resolveServerEntry(isPackaged: boolean, resourcesPath: string): string {
  if (isPackaged) {
    return path.join(resourcesPath, "server", "cli.mjs");
  }
  return fileURLToPath(new URL("../../../../packages/vibest/dist/cli.mjs", import.meta.url));
}

/**
 * Spawn the vibest server and wait for it to report the port it bound.
 *
 * It runs on Electron's own Node runtime (`process.execPath` +
 * ELECTRON_RUN_AS_NODE), so a packaged app needs no Node installed. It binds a
 * random loopback port, so two launches never collide, and it is guarded by a
 * token minted here and never written to disk.
 */
export async function startBackend(options: StartBackendOptions): Promise<Backend> {
  const token = randomUUID();
  const entry = resolveServerEntry(app.isPackaged, process.resourcesPath);

  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VIBEST_AUTH_TOKEN: token,
      VIBEST_PORT: "0",
      VIBEST_CORS_ORIGINS: options.corsOrigins.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[vibest-server] ${chunk.toString().trimEnd()}`);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Backend did not report ready within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);

    const settleError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };

    child.once("error", settleError);
    child.once("exit", (code) => {
      settleError(new Error(`Backend exited during startup with code ${code}`));
    });

    if (!child.stdout) {
      settleError(new Error("Backend stdout is not readable"));
      return;
    }

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const ready = parseReadyLine(line);
      if (!ready) {
        console.log(`[vibest-server] ${line}`);
        return;
      }
      clearTimeout(timer);
      child.removeListener("error", settleError);
      child.removeAllListeners("exit");
      resolve(ready.port);
    });
  });

  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    token,
    stop() {
      child.kill();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm install && pnpm --filter desktop test`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): spawn the vibest server on Electron's node runtime"
```

---

## Task 11: Desktop — the `vibest://app` protocol handler

**Files:**

- Create: `apps/desktop/src/main/protocol.ts`
- Create: `apps/desktop/src/main/protocol.test.ts`

**Interfaces:**

- Produces:
  - `SCHEME` (`"vibest"`), `HOST` (`"app"`), `APP_ORIGIN` (`"vibest://app"`)
  - `registerAppScheme(): void` — must be called **before** `app.whenReady()`
  - `registerAppProtocol(rendererRoot: string): void` — call after ready
  - `resolveAssetPath(rendererRoot: string, pathname: string): string | null` — exported for test

**The bug this must not have:** the app uses TanStack Router, so an extension-less path like `/chat/abc123` is a _route_, not a file. Reloading on such a URL must serve `index.html`, or the window goes blank. Vite's dev server does this for you; this handler must do it explicitly. Task 14's e2e asserts it.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/protocol.test.ts`:

```ts
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAssetPath } from "./protocol";

const ROOT = path.resolve("/app/renderer");

describe("resolveAssetPath", () => {
  it("resolves a file inside the renderer root", () => {
    expect(resolveAssetPath(ROOT, "/assets/index.js")).toBe(path.join(ROOT, "assets", "index.js"));
  });

  it("resolves the root path", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(ROOT);
  });

  it("decodes percent-encoded paths", () => {
    expect(resolveAssetPath(ROOT, "/assets/a%20b.js")).toBe(path.join(ROOT, "assets", "a b.js"));
  });

  it("refuses to escape the renderer root", () => {
    expect(resolveAssetPath(ROOT, "/../../etc/passwd")).toBeNull();
  });

  it("refuses an encoded traversal", () => {
    expect(resolveAssetPath(ROOT, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter desktop test`
Expected: FAIL — cannot resolve `./protocol`.

- [ ] **Step 3: Write the handler**

Create `apps/desktop/src/main/protocol.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

export const SCHEME = "vibest";
export const HOST = "app";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

/**
 * Must run before app.whenReady(): Electron only accepts privileged-scheme
 * registration during startup. `standard` gives the scheme a real origin (so
 * the renderer isn't opaque), `secure` lets it use APIs gated on secure
 * contexts, and `supportFetchAPI` lets the app fetch its own assets.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Map a request path to a file inside the renderer bundle, or null if it tries
 * to escape it.
 */
export function resolveAssetPath(rendererRoot: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const file = path.resolve(rendererRoot, `.${decoded}`);
  const relative = path.relative(rendererRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

/**
 * Serve the renderer bundle off disk. This protocol is *only* an asset server —
 * it never proxies the backend, which the renderer calls directly on loopback.
 */
export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response("Not found", { status: 404 });
    }

    const file = resolveAssetPath(rendererRoot, url.pathname);
    if (!file) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback. The router owns every path that isn't a real file
    // (/chat/abc123, and every deep link the user reloads on), so those must
    // serve the shell, not 404.
    const target =
      fs.existsSync(file) && fs.statSync(file).isFile()
        ? file
        : path.join(rendererRoot, "index.html");

    return net.fetch(pathToFileURL(target).toString());
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter desktop test`
Expected: PASS — 5 new tests, 7 total.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): serve the renderer over a vibest:// protocol"
```

---

## Task 12: Desktop — preload bridge, renderer entry, and window wiring

**Files:**

- Create: `apps/desktop/src/shared/bridge.ts`
- Create: `apps/desktop/src/renderer/main.tsx`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/electron.vite.config.ts`

**Interfaces:**

- Consumes: `startBackend` (Task 10); `registerAppScheme`, `registerAppProtocol`, `APP_ORIGIN` (Task 11); `createApp`, `Platform` from `@vibest/app` (Tasks 7–8).
- Produces:
  - `DesktopBridge` (`apps/desktop/src/shared/bridge.ts`) — `{ os: string; backend: BackendConnection }`
  - `window.vibest: DesktopBridge` in the renderer
  - IPC channel `vibest:bootstrap` (synchronous), main → preload

**Why synchronous IPC:** the renderer needs the backend's origin and token before its first module evaluates. Passing them as `additionalArguments` would put the token in the renderer process's command line, where any local process can read it — which would undo the point of having a token. `ipcRenderer.sendSync` in the preload keeps it in memory.

- [ ] **Step 1: Define the bridge type**

Create `apps/desktop/src/shared/bridge.ts`:

```ts
export type BackendConnection = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  token: string;
};

/** What the preload exposes to the renderer. Kept small on purpose. */
export type DesktopBridge = {
  os: string;
  backend: BackendConnection;
};
```

- [ ] **Step 2: Expose it from the preload**

Replace the whole of `apps/desktop/src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

import type { BackendConnection, DesktopBridge } from "../shared/bridge";

// Synchronous on purpose: the renderer's first module needs the backend's
// origin and token, and the main process already has both by the time this
// window exists (it awaits the backend before creating the window).
const backend = ipcRenderer.sendSync("vibest:bootstrap") as BackendConnection;

const bridge: DesktopBridge = {
  os: process.platform,
  backend,
};

contextBridge.exposeInMainWorld("vibest", bridge);
```

- [ ] **Step 3: Type the global**

Replace the whole of `apps/desktop/src/preload/index.d.ts`:

```ts
import type { DesktopBridge } from "../shared/bridge";

declare global {
  interface Window {
    vibest: DesktopBridge;
  }
}

export {};
```

- [ ] **Step 4: Write the desktop renderer entry**

Create `apps/desktop/src/renderer/main.tsx`:

```tsx
import { createApp } from "@vibest/app/app";
import type { Platform } from "@vibest/app/platform";
import { createRoot } from "react-dom/client";

import "@vibest/app/index.css";

const bridge = window.vibest;

if (!bridge) {
  throw new Error("Preload bridge missing — the renderer cannot reach its backend");
}

const platform: Platform = {
  host: "desktop",
  os: bridge.os,
  backend: bridge.backend,
};

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(createApp(platform));
```

- [ ] **Step 5: Update the renderer HTML**

Replace the whole of `apps/desktop/src/renderer/index.html`. The `connect-src` additions are load-bearing: the renderer's origin is `vibest://app`, but it calls the backend on loopback over both HTTP and WebSocket.

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Vibest</title>
    <!-- The renderer is served from vibest://app but talks to the backend on
         loopback, so http:/ws: to 127.0.0.1 must be allowed explicitly. -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"
    />
  </head>

  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Wire the main process**

Replace the whole of `apps/desktop/src/main/index.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import icon from "../../resources/icon.png?asset";
import { type Backend, startBackend } from "./backend";
import { APP_ORIGIN, registerAppProtocol, registerAppScheme } from "./protocol";

let backend: Backend | undefined;

// Two launches would spawn two backends, each on its own port, each with its
// own agent — so the second launch focuses the first window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Must precede app.whenReady().
registerAppScheme();

function rendererRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer");
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      // .js, not .mjs: a sandboxed preload must be CommonJS.
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (is.dev && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // The origin ROOT, not /index.html. The router matches on pathname, and
    // "/index.html" matches no route — the window would render Not Found. The
    // protocol handler's SPA fallback serves index.html for "/" anyway.
    void mainWindow.loadURL(`${APP_ORIGIN}/`);
  }
}

app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
});

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.vibest.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // In dev the renderer is served by Vite over http, so that origin must be
  // allowed too; in production it is only ever the app protocol.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const corsOrigins = [APP_ORIGIN, ...(is.dev && devUrl ? [new URL(devUrl).origin] : [])];

  try {
    backend = await startBackend({ corsOrigins });
  } catch (error) {
    dialog.showErrorBox(
      "Vibest could not start",
      `The local server failed to start.\n\n${(error as Error).message}`,
    );
    app.quit();
    return;
  }

  // The preload asks for this before the renderer's first module runs.
  ipcMain.on("vibest:bootstrap", (event) => {
    event.returnValue = backend
      ? { httpBaseUrl: backend.httpBaseUrl, wsBaseUrl: backend.wsBaseUrl, token: backend.token }
      : null;
  });

  registerAppProtocol(rendererRoot());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  backend?.stop();
  backend = undefined;
});
```

- [ ] **Step 7: Point electron-vite's renderer at the shared app**

Replace the whole of `apps/desktop/electron.vite.config.ts`:

```ts
import { appAlias, appVitePlugins } from "@vibest/app/vite";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        // CommonJS: a sandboxed renderer cannot load an ESM preload.
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    // The renderer *is* apps/app, compiled from source into the Electron
    // bundle — not a copy of apps/app/dist. Same plugins, same alias.
    root: "src/renderer",
    resolve: {
      alias: appAlias(),
    },
    plugins: appVitePlugins(),
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: "src/renderer/index.html",
        },
      },
    },
  },
});
```

- [ ] **Step 8: Add the app dependency and the predev hook**

In `apps/desktop/package.json`, add to `dependencies`:

```json
    "@vibest/app": "workspace:*",
```

and change the `dev` script, adding a `predev` before it. The backend is spawned from `packages/vibest/dist`, so it must be built before Electron starts — the same reason opencode has a `predev`.

```json
    "predev": "pnpm --filter @vibest/cli build",
    "dev": "electron-vite dev",
```

- [ ] **Step 9: Build and typecheck**

Run: `pnpm install && pnpm --filter desktop typecheck && pnpm --filter desktop exec electron-vite build`
Expected: PASS — `apps/desktop/dist/{main,preload,renderer}` all produced.

- [ ] **Step 10: Run the app for real**

Run: `pnpm --filter desktop dev`
Expected: the Vibest window opens showing the chat UI. Open DevTools (F12) and confirm: no CORS errors, no 401s, and the WebSocket to `ws://127.0.0.1:<port>/ws/rpc?ticket=...` shows status 101. Send a prompt and confirm the response streams.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): render the vibest app against a spawned backend"
```

---

## Task 13: Desktop — package the server into the app bundle

**Files:**

- Modify: `apps/desktop/src/main/backend.ts` (+ `backend.test.ts`)
- Modify: `apps/desktop/package.json` (build scripts)

**Interfaces:**

- Consumes: `resolveServerEntry(isPackaged=true, resourcesPath)` (Task 10), now → `<resources>/app.asar/node_modules/@vibest/cli/dist/cli.mjs`.

**Why not `extraResources`:** copying `packages/vibest/dist` to `<resources>/server` puts `cli.mjs` on disk but leaves its imports (`@orpc/server`, `sirv`, `ws`, `ai`, the Claude Agent SDK) unresolvable — the bundle is not self-contained, and nothing supplies a `node_modules` next to the copy. Bundling those deps in is not an option either: the Claude Agent SDK locates its own manifest and native binary relative to its package directory. `@vibest/cli` is already a production dependency of the desktop app, so electron-builder collects it _with its whole dependency tree_, correctly flattened out of pnpm's store, into the asar. Spawn it from there. Electron's Node reads asar paths transparently, including under `ELECTRON_RUN_AS_NODE`.

- [ ] **Step 1: Point the packaged entry at the collected dependency**

In `apps/desktop/src/main/backend.ts`, the packaged branch of `resolveServerEntry` becomes:

```ts
if (isPackaged) {
  return path.join(resourcesPath, "app.asar", "node_modules", "@vibest", "cli", "dist", "cli.mjs");
}
```

Update the corresponding expectation in `apps/desktop/src/main/backend.test.ts`.

- [ ] **Step 2: Make the desktop build depend on the server build**

In `apps/desktop/package.json`, change the build scripts so the server bundle exists before packaging:

```json
    "build": "electron-vite build",
    "prebuild": "pnpm --filter @vibest/cli build",
    "build:unpack": "pnpm run build && electron-builder --dir",
    "build:mac": "pnpm run build && electron-builder --mac",
```

- [ ] **Step 3: Package an unpacked build**

Run: `pnpm --filter desktop run build:unpack`
Expected: PASS.

- [ ] **Step 4: Verify the server landed in the bundle**

Check that `node_modules/@vibest/cli/dist/cli.mjs` is listed inside `apps/desktop/release/mac-arm64/Vibest.app/Contents/Resources/app.asar` (read the asar header, or run the entry directly with `ELECTRON_RUN_AS_NODE=1 VIBEST_PORT=0`, which should print a ready line).
Expected: present, and it boots. (On a non-macOS host, substitute the platform's output directory under `apps/desktop/release/`.)

- [ ] **Step 5: Launch the packaged app**

Run: `open apps/desktop/release/mac-arm64/Vibest.app`
Expected: the window opens and the chat UI loads — proving the packaged app spawns its bundled server using Electron's own Node runtime, with no system Node involved.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "build(desktop): bundle the vibest server as an app resource"
```

---

## Task 14: Desktop — end-to-end tests against the packaged build

**Files:**

- Create: `apps/desktop/e2e/tests/app.spec.ts`
- Modify: `apps/desktop/e2e/tests/fixtures.ts`
- Modify: `apps/desktop/package.json` (e2e script)

**Interfaces:**

- Consumes: the built app from `apps/desktop/dist` and the built server from `packages/vibest/dist`.

**Why this task matters more than it looks:** `pnpm dev` loads the renderer from the Vite dev server, so the `vibest://` protocol handler — including its SPA fallback — **never runs in development**. This suite is the only thing that exercises it. The deep-link test below is not decoration; it is the regression test for "works in dev, blank window when packaged."

- [ ] **Step 1: Give the fixture more time to boot**

The app now spawns a backend before it shows a window. In `apps/desktop/e2e/tests/fixtures.ts`, the `window` fixture must wait for the app to actually render. Replace the `window` fixture:

```ts
  window: async ({ electronApp }, use) => {
    // The main process spawns and awaits the backend before creating a window,
    // so the first window can take a few seconds to appear.
    const window = await electronApp.firstWindow({ timeout: 30_000 });

    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 900 });

    await use(window);
  },
```

Leave the `electronApp` fixture unchanged.

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/e2e/tests/app.spec.ts`:

```ts
import { expect, test } from "./fixtures.js";

test.describe("App launch", () => {
  test("opens a window and renders the app", async ({ window }) => {
    await expect(window.locator("#root")).not.toBeEmpty();
  });

  test("serves the renderer over the vibest:// protocol", async ({ window }) => {
    const origin = await window.evaluate(() => location.origin);
    expect(origin).toBe("vibest://app");
  });
});

test.describe("Backend connection", () => {
  test("hands the renderer a loopback backend and a token", async ({ window }) => {
    const backend = await window.evaluate(() => window.vibest?.backend);
    expect(backend?.httpBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(backend?.wsBaseUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(backend?.token).toBeTruthy();
  });

  test("the spawned server answers on its reported port", async ({ window }) => {
    const status = await window.evaluate(async () => {
      const base = window.vibest.backend.httpBaseUrl;
      const response = await fetch(`${base}/api/health`);
      return response.status;
    });
    expect(status).toBe(200);
  });

  test("rejects an unauthenticated RPC call", async ({ window }) => {
    const status = await window.evaluate(async () => {
      const base = window.vibest.backend.httpBaseUrl;
      const response = await fetch(`${base}/api/ws-ticket`, { method: "POST" });
      return response.status;
    });
    expect(status).toBe(401);
  });
});

test.describe("Deep links", () => {
  // The protocol handler serves files off disk and never runs in `pnpm dev`,
  // where Vite serves the renderer instead. A router path is not a file, so
  // without an SPA fallback this reload 404s and the window goes blank — a bug
  // that only ever appears in a packaged build. This is its regression test.
  test("reloading on a router path serves the app, not a 404", async ({ electronApp, window }) => {
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      await win?.loadURL("vibest://app/chat/deep-link-regression");
    });

    await window.waitForLoadState("domcontentloaded");

    expect(await window.evaluate(() => location.pathname)).toBe("/chat/deep-link-regression");
    await expect(window.locator("#root")).not.toBeEmpty();
  });
});
```

- [ ] **Step 3: Make the e2e script build both bundles**

In `apps/desktop/package.json`, change the e2e scripts — the packaged app spawns the server from `packages/vibest/dist`, so it must exist:

```json
    "e2e": "pnpm run prebuild && pnpm run build && playwright test -c e2e/playwright.config.ts",
    "e2e:headed": "pnpm run prebuild && pnpm run build && playwright test -c e2e/playwright.config.ts --headed",
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter desktop e2e`
Expected: PASS — 6 tests.

If the deep-link test fails with an empty `#root`, the SPA fallback in `apps/desktop/src/main/protocol.ts` is wrong — that is exactly the bug this test exists to catch. Fix the handler, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "test(desktop): cover protocol, backend handshake, and deep-link reload"
```

---

## Task 15: Full-workspace verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Clean install**

Run: `pnpm install`
Expected: PASS, no peer warnings that mention `@vibest/web`.

- [ ] **Step 2: Full check**

Run: `pnpm check`
Expected: PASS — lint, format, and typecheck all clean across the workspace.

- [ ] **Step 3: Full test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Full build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Verify browser mode is intact**

Run: `node packages/vibest/dist/cli.mjs`
Then open `http://127.0.0.1:4000`.
Expected: the chat UI loads and works. No token, no CORS, no ticket — the same-origin path is unchanged. This is the check that the desktop work did not quietly break `npx vibest`.
Stop the server with Ctrl-C.

- [ ] **Step 6: Verify desktop mode is intact**

Run: `pnpm --filter desktop e2e`
Expected: PASS.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "chore: fix workspace-wide checks after desktop migration"
```

---

## Deferred (explicitly out of scope)

These were considered and ruled out of this change. None of them requires revisiting a decision above.

- **Project picker.** `packages/server` has a `ProjectService` (create/list/remove by path) that is not wired into the RPC contract, and no UI selects a project. Until it exists, the server operates on its own working directory. The native folder dialog it will need is the first real occupant of `Platform`'s `desktop` arm.
- **Auto-update** (`electron-updater`) and **code signing / notarization**. `electron-builder.yml` still has `notarize: false`, `identity: null`, and a placeholder `publish.url`. Without these the app runs locally but cannot be distributed.
- **Backend crash recovery.** `startBackend` reports a spawn failure and quits. It does not restart a backend that dies later (t3code does, with exponential backoff). Add it when a crashing backend is an observed problem, not before.
- **Native menus, notifications, window-state persistence, multi-window.**
- **`packages/services`** stays in the workspace, unreferenced, at the user's request.
