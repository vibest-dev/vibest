import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { renderSafeMarkdownHtml } from "../src/markdown-safe.ts"
import { injectHtmlPreviewBridge } from "../src/preview-bridge.ts"
import {
  readProjectTextFile,
  resolveSafeProjectFilePath,
  scanProjectFiles,
  writeProjectTextFile,
} from "../src/project-files.ts"
import { createWebServer, type RunningWebServer } from "../src/server.ts"
import { createVibestBridge } from "../src/vibest-bridge.ts"
import { parseVibestMessageBlocks } from "../src/xml-parser.ts"

describe("vibest-web xml-parser", () => {
  it("parses vibest-agent-message and vibest-message into structured blocks", () => {
    const raw = [
      "Coordinator received updates:",
      "<vibest-agent-message>",
      "<agent-id>a1b2c3d4-1111-2222-3333-444455556666</agent-id>",
      "<message>Implemented panel layout. Build and lint clean.\n\nDetails:\n- Added ProjectsPanel\n- Added SessionsPanel</message>",
      "</vibest-agent-message>",
      "<vibest-message>Session a1b2c3d4 pushed feat/panel-layout.</vibest-message>",
    ].join("\n")

    const blocks = parseVibestMessageBlocks(raw)
    expect(blocks.length).toBe(3)
    expect(blocks[0]?.kind).toBe("text")

    const report = blocks[1]
    expect(report?.kind).toBe("agent-report")

    if (report?.kind === "agent-report") {
      expect(report.agentId).toBe("a1b2c3d4-1111-2222-3333-444455556666")
      expect(report.firstLine).toBe("Implemented panel layout. Build and lint clean.")
      expect(report.details).toContain("Added ProjectsPanel")
    }

    const notice = blocks[2]
    expect(notice?.kind).toBe("system-notice")

    if (notice?.kind === "system-notice") {
      expect(notice.body).toContain("feat/panel-layout")
    }
  })
  it("parses real Vibest <session-id>, optional <machine>, and <vibest-message><message> envelopes", () => {
    const raw = [
      "<vibest-agent-message>",
      "<session-id>sess-9988</session-id>",
      "<machine>racknerd</machine>",
      "<message>Fixed dangling symlink escape.\n\nDetails:\n- Added lstat walk</message>",
      "</vibest-agent-message>",
      "<vibest-message>",
      "<message>Session sess-9988 finished.</message>",
      "</vibest-message>",
    ].join("\n")

    const blocks = parseVibestMessageBlocks(raw)
    expect(blocks.length).toBe(2)

    const report = blocks[0]
    expect(report?.kind).toBe("agent-report")

    if (report?.kind === "agent-report") {
      expect(report.agentId).toBe("sess-9988")
      expect(report.firstLine).toBe("Fixed dangling symlink escape.")
      expect(report.details).toContain("Added lstat walk")
    }

    const notice = blocks[1]
    expect(notice?.kind).toBe("system-notice")

    if (notice?.kind === "system-notice") {
      expect(notice.body).toBe("Session sess-9988 finished.")
    }
  })
})

describe("vibest-web markdown-safe and preview-bridge", () => {
  it("sanitizes dangerous tags and javascript urls while preserving tables", () => {
    const md = [
      "# Spec",
      "",
      "| Col | Value |",
      "| --- | --- |",
      "| Mode | Split |",
      "",
      '<script>alert(1)</script><a href="javascript:alert(2)">bad</a><a href="https://vibest.dev">good</a>',
    ].join("\n")

    const html = renderSafeMarkdownHtml(md)
    expect(html).toContain("<table>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("javascript:")
    expect(html).toContain('href="https://vibest.dev"')
  })

  it("injects preview bridge before closing body tag", () => {
    const injected = injectHtmlPreviewBridge("<html><body><button id='go'>Go</button></body></html>")
    expect(injected).toContain('data-vibest-web-bridge="true"')
    expect(injected.indexOf("data-vibest-web-bridge")).toBeLessThan(injected.indexOf("</body>"))
  })
})

describe("vibest-web project-files and HTTP/SSE server", () => {
  const tempDirs: string[] = []
  const servers: RunningWebServer[] = []

  afterEach(() => {
    for (const srv of servers.splice(0)) {
      srv.stop()
    }

    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("blocks path traversal and scans artifacts, docs, memories, and preferences", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-files-"))
    tempDirs.push(home)
    const projectId = "proj-1"
    const base = path.join(home, "projects", projectId)
    fs.mkdirSync(path.join(base, "artifacts"), { recursive: true })
    fs.mkdirSync(path.join(base, "docs"), { recursive: true })
    fs.mkdirSync(path.join(base, "memories"), { recursive: true })
    fs.writeFileSync(path.join(base, "preferences.md"), "# Preferences\n", "utf8")
    fs.writeFileSync(path.join(base, "artifacts", "board.excalidraw"), "{}", "utf8")
    fs.writeFileSync(path.join(base, "docs", "arch.md"), "# Arch\n", "utf8")
    fs.writeFileSync(path.join(base, "memories", "MEMORY.md"), "# Memory\n", "utf8")

    expect(resolveSafeProjectFilePath(home, projectId, "../other/secret.txt")).toBeNull()
    expect(resolveSafeProjectFilePath(home, projectId, "sessions/raw.log")).toBeNull()
    expect(readProjectTextFile(home, projectId, "docs/arch.md")).toBe("# Arch\n")
    expect(writeProjectTextFile(home, projectId, "artifacts/new.md", "hello")).toBe(true)

    const files = scanProjectFiles(home, projectId)
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "artifacts/board.excalidraw",
      "artifacts/new.md",
      "docs/arch.md",
      "memories/MEMORY.md",
      "preferences.md",
    ])
  })

  it("serves state, SSE stream, preview, peek, send, interrupt, archive, and file save", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-srv-"))
    tempDirs.push(home)
    const projectId = "proj-vibest"
    const base = path.join(home, "projects", projectId)
    fs.mkdirSync(path.join(base, "artifacts"), { recursive: true })
    fs.writeFileSync(
      path.join(base, "artifacts", "demo.html"),
      "<html><body><main><h1>Panel</h1></main></body></html>",
      "utf8",
    )

    const demoState = {
      version: "0.0.2-dev",
      load: {
        sampledAt: Date.now(),
        cpuCount: 12,
        cpuUtilization: 0.24,
        memoryTotalBytes: 32 * 1024 ** 3,
        memoryAvailableBytes: 18 * 1024 ** 3,
        workingExecutions: 1,
      },
      projects: [
        {
          id: projectId,
          name: "vibest",
          directory: "/tmp/vibest",
          entrySessionId: "entry-1",
          activity: "working",
          machine: "local",
          branch: "main",
        },
      ],
      sessions: [
        {
          id: "entry-1",
          name: "coordinator",
          agent: "coordinator",
          harness: "claude",
          provider: null,
          model: "opus-4.6",
          status: "idle",
          executionState: "completed",
          projectId,
          parentId: null,
          runtime: "hc",
          machine: "local",
          worktree: "/tmp/vibest",
          repositoryRoot: "/tmp/vibest",
          git: { branch: "main", pushed: true, saved: true, why: "" },
          createdAt: Date.now() - 60_000,
          lastActive: Date.now() - 10_000,
          startedAt: Date.now() - 60_000,
          exitedAt: null,
          task: "Coordinate work",
          summary: "Ready",
          isEntry: true,
          needsYou: false,
        },
        {
          id: "sub-1",
          name: "panel-ui",
          agent: "general",
          harness: "agy",
          provider: null,
          model: "gemini-4",
          status: "working",
          executionState: "open",
          projectId,
          parentId: "entry-1",
          runtime: "hc",
          machine: "local",
          worktree: "/tmp/wt-sub1",
          repositoryRoot: "/tmp/vibest",
          git: { branch: "feat/web-hub-cursor-panels", pushed: false, saved: true, why: "" },
          createdAt: Date.now() - 30_000,
          lastActive: Date.now(),
          startedAt: Date.now() - 30_000,
          exitedAt: null,
          task: "Build panel UI",
          summary: "Building modular panels",
          isEntry: false,
          needsYou: false,
        },
      ],
      timelines: [],
      peeks: {
        "sub-1": "\x1b[32mPASS\x1b[0m panel-ui build clean\r\n",
      },
    }

    fs.writeFileSync(path.join(home, "web-demo-state.json"), JSON.stringify(demoState), "utf8")

    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const stateRes = await fetch(`${server.url}/api/state`)
    expect(stateRes.status).toBe(200)
    const stateJson = (await stateRes.json()) as { projects: Array<{ name: string }>; sessions: Array<{ id: string }> }
    expect(stateJson.projects[0]?.name).toBe("vibest")
    expect(stateJson.sessions.length).toBe(2)

    const previewRes = await fetch(`${server.url}/api/projects/${projectId}/preview?path=artifacts/demo.html`)
    expect(previewRes.status).toBe(200)
    expect(await previewRes.text()).toContain("vibest-web-bridge")

    const peekRes = await fetch(`${server.url}/api/sessions/sub-1/peek`)
    const peekJson = (await peekRes.json()) as { terminal: string }
    expect(peekJson.terminal).toContain("panel-ui build clean")

    const sendRes = await fetch(`${server.url}/api/sessions/entry-1/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ message: "Ship it", attachments: ["artifacts/demo.html"] }),
    })

    expect(sendRes.status).toBe(200)

    const saveRes = await fetch(`${server.url}/api/projects/${projectId}/file`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ path: "artifacts/saved.excalidraw", content: '{"elements":[]}' }),
    })

    expect(saveRes.status).toBe(200)
    expect(readProjectTextFile(home, projectId, "artifacts/saved.excalidraw")).toBe('{"elements":[]}')

    const intRes = await fetch(`${server.url}/api/sessions/sub-1/interrupt`, {
      method: "POST",
      headers: { origin: server.url },
    })

    expect(intRes.status).toBe(200)

    const archRes = await fetch(`${server.url}/api/sessions/sub-1/archive`, {
      method: "POST",
      headers: { origin: server.url },
    })

    expect(archRes.status).toBe(200)
  })

  it("B1: blocks projectId path traversal and symlink escape on read and write", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b1-"))
    tempDirs.push(tmp)
    const vibestHome = path.join(tmp, "vibest-home")
    const outsideDir = path.join(tmp, "outside-secret")
    fs.mkdirSync(path.join(vibestHome, "projects", "legit", "artifacts"), { recursive: true })
    fs.mkdirSync(path.join(outsideDir, "docs"), { recursive: true })
    fs.writeFileSync(path.join(outsideDir, "docs", "secret.txt"), "TOP_SECRET_DATA", "utf8")
    fs.symlinkSync(
      path.join(outsideDir, "docs", "secret.txt"),
      path.join(vibestHome, "projects", "legit", "artifacts", "link.txt"),
    )

    expect(resolveSafeProjectFilePath(vibestHome, "../../outside-secret", "docs/secret.txt")).toBeNull()
    expect(resolveSafeProjectFilePath(vibestHome, "legit", "artifacts/link.txt")).toBeNull()

    const server = await createWebServer({ port: 0, vibestHome, demoMode: true, safeActions: true })
    servers.push(server)

    const escapedId = encodeURIComponent("../../outside-secret")
    const getRes = await fetch(`${server.url}/api/projects/${escapedId}/file?path=docs/secret.txt`)
    expect(getRes.status).toBe(400)

    const putRes = await fetch(`${server.url}/api/projects/${escapedId}/file`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ path: "artifacts/pwned.txt", content: "WRITTEN_OUTSIDE" }),
    })

    expect(putRes.status).toBe(400)
    expect(fs.existsSync(path.join(outsideDir, "artifacts", "pwned.txt"))).toBe(false)
  })

  it("B1 regression: blocks dangling symlink write escape and symlinked file reads", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b1-dangling-"))
    tempDirs.push(tmp)
    const vibestHome = path.join(tmp, "vibest-home")
    const outsideDir = path.join(tmp, "outside-target")
    fs.mkdirSync(path.join(vibestHome, "projects", "legit", "artifacts"), { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    const pwnedPath = path.join(outsideDir, "pwned.txt")
    fs.symlinkSync(pwnedPath, path.join(vibestHome, "projects", "legit", "artifacts", "dangling.txt"))

    expect(resolveSafeProjectFilePath(vibestHome, "legit", "artifacts/dangling.txt")).toBeNull()
    expect(writeProjectTextFile(vibestHome, "legit", "artifacts/dangling.txt", "ESCAPED")).toBe(false)
    expect(fs.existsSync(pwnedPath)).toBe(false)

    const server = await createWebServer({ port: 0, vibestHome, demoMode: true, safeActions: true })
    servers.push(server)

    const putRes = await fetch(`${server.url}/api/projects/legit/file`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ path: "artifacts/dangling.txt", content: "ESCAPED" }),
    })

    expect(putRes.status).toBe(400)
    expect(fs.existsSync(pwnedPath)).toBe(false)

    const getRes = await fetch(`${server.url}/api/projects/legit/file?path=artifacts/dangling.txt`)
    expect(getRes.status).toBe(404)
  })

  it("returns 404 instead of 500 EISDIR when GET /api/projects/:id/file targets a directory", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-dir-"))
    tempDirs.push(home)
    fs.mkdirSync(path.join(home, "projects", "proj-dir", "artifacts", "nested"), { recursive: true })

    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const textRes = await fetch(`${server.url}/api/projects/proj-dir/file?path=artifacts/nested`)
    expect(textRes.status).toBe(404)

    const rawRes = await fetch(`${server.url}/api/projects/proj-dir/file?path=artifacts/nested&raw=1`)
    expect(rawRes.status).toBe(404)
  })

  it("B-SYM-1 regression: blocks in-project symlink escape from artifacts/ to sessions/", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-bsym1-"))
    tempDirs.push(tmp)
    const vibestHome = path.join(tmp, "vibest-home")
    const projDir = path.join(vibestHome, "projects", "legit")
    fs.mkdirSync(path.join(projDir, "artifacts"), { recursive: true })
    fs.mkdirSync(path.join(projDir, "sessions"), { recursive: true })
    fs.writeFileSync(path.join(projDir, "sessions", "raw.log"), "INTERNAL_SESSION_LOG", "utf8")
    fs.symlinkSync(path.join("..", "sessions", "raw.log"), path.join(projDir, "artifacts", "leak.log"))

    expect(resolveSafeProjectFilePath(vibestHome, "legit", "artifacts/leak.log")).toBeNull()
    expect(readProjectTextFile(vibestHome, "legit", "artifacts/leak.log")).toBeNull()

    const server = await createWebServer({ port: 0, vibestHome, demoMode: true, safeActions: true })
    servers.push(server)

    const getRes = await fetch(`${server.url}/api/projects/legit/file?path=artifacts/leak.log`)
    expect(getRes.status).toBe(404)
  })

  it("B-LIVE-1 regression: retains user message in getTimeline after live sendToSession", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-blive1-"))
    tempDirs.push(tmp)
    const sockPath = path.join(tmp, "vibest.sock")

    const mockDaemon = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/"

      if (req.method === "GET" && reqUrl.startsWith("/api/daemon/ping")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ version: "0.0.2-dev", protocol: 1 }))

        return
      }

      if (req.method === "GET" && reqUrl.startsWith("/api/machine/load")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "unavailable" }))

        return
      }

      if (req.method === "GET" && reqUrl.startsWith("/api/watch")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        res.write('data: {"_tag":"Snapshot","projects":[],"sessions":[],"machines":[]}\n\n')

        return
      }

      if (req.method === "POST" && reqUrl.startsWith("/api/session/s1/send")) {
        req.resume()
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "s1", name: "coordinator" }))

        return
      }

      if (req.method === "GET" && reqUrl.startsWith("/api/session/s1")) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))

        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => {
      mockDaemon.listen(sockPath, resolve)
    })

    const bridge = createVibestBridge({ vibestHome: tmp, repositoryRoot: tmp, demoMode: false, safeActions: false })

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for live daemon")), 3000)

        const unsub = bridge.subscribe((ev) => {
          if (ev.type === "daemon" && ev.data.connected) {
            clearTimeout(timer)
            unsub()
            resolve()
          }
        })

        if (bridge.snapshot().daemon.connected) {
          clearTimeout(timer)
          unsub()
          resolve()
        }
      })

      const sent = await bridge.sendToSession("s1", "hello live timeline", [])
      expect(sent.ok).toBe(true)

      const timeline = await bridge.getTimeline("p1", "s1")
      expect(timeline.map((e) => e.content)).toContain("hello live timeline")
    } finally {
      bridge.stop()
      mockDaemon.closeAllConnections()
      mockDaemon.close()
    }
  })

  it("B2: rejects non-loopback Host, cross-origin Origin, and non-JSON Content-Type on mutations", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b2-"))
    tempDirs.push(home)
    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/state",
          method: "GET",
          headers: { host: "evil.attacker.com" },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )

      req.on("error", reject)
      req.end()
    })

    expect(badHostStatus).toBe(403)

    const badOrigin = await fetch(`${server.url}/api/sessions/any-session/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ message: "CSRF injected prompt" }),
    })

    expect(badOrigin.status).toBe(403)

    const badContentType = await fetch(`${server.url}/api/sessions/any-session/send`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: server.url },
      body: JSON.stringify({ message: "text/plain CSRF" }),
    })

    expect(badContentType.status).toBe(415)

    const crossSiteInterrupt = await fetch(`${server.url}/api/sessions/any-session/interrupt`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })

    expect(crossSiteInterrupt.status).toBe(403)
  })

  it("B3: serves preview and raw files with sandbox CSP and nosniff headers", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b3-"))
    tempDirs.push(home)
    const projectId = "proj-b3"
    const base = path.join(home, "projects", projectId)
    fs.mkdirSync(path.join(base, "artifacts"), { recursive: true })
    fs.writeFileSync(path.join(base, "artifacts", "demo.html"), "<html><body><h1>Hi</h1></body></html>", "utf8")
    fs.writeFileSync(path.join(base, "artifacts", "pic.svg"), "<svg><script>alert(1)</script></svg>", "utf8")

    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const previewRes = await fetch(`${server.url}/api/projects/${projectId}/preview?path=artifacts/demo.html`)
    expect(previewRes.status).toBe(200)
    expect(previewRes.headers.get("content-security-policy")).toBe("sandbox allow-scripts")
    expect(previewRes.headers.get("x-content-type-options")).toBe("nosniff")

    const rawSvgRes = await fetch(`${server.url}/api/projects/${projectId}/file?path=artifacts/pic.svg&raw=1`)
    expect(rawSvgRes.status).toBe(200)
    expect(rawSvgRes.headers.get("content-security-policy")).toBe("sandbox")
    expect(rawSvgRes.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("B4: closes live vibestd Unix socket cleanly when bridge.stop() is called", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b4-"))
    tempDirs.push(tmp)
    const sockPath = path.join(tmp, "vibest.sock")
    let open = 0
    let closed = 0
    let resolveOpened: (() => void) | null = null
    let resolveClosed: (() => void) | null = null

    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve
    })

    const allClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })

    const netSrv = net.createServer((socket) => {
      open += 1
      socket.resume()
      resolveOpened?.()
      socket.on("close", () => {
        closed += 1

        if (closed >= open) resolveClosed?.()
      })
    })

    await new Promise<void>((resolve) => {
      netSrv.listen(sockPath, resolve)
    })

    const bridge = createVibestBridge({ vibestHome: tmp, repositoryRoot: tmp, demoMode: false, safeActions: true })

    try {
      await Promise.race([
        opened,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for socket open")), 3000),
        ),
      ])
      bridge.stop()
      await Promise.race([
        allClosed,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for socket close")), 3000),
        ),
      ])
    } finally {
      bridge.stop()
      netSrv.close()
    }

    expect(open).toBeGreaterThanOrEqual(1)
    expect(closed).toBe(open)
  })

  it("B5: preserves original session.task after sendToSession instead of shadowing timeline", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b5-"))
    tempDirs.push(home)

    const demoState = {
      version: "0.0.2-dev",
      load: {
        sampledAt: Date.now(),
        cpuCount: 8,
        cpuUtilization: 0.1,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryAvailableBytes: 8 * 1024 ** 3,
        workingExecutions: 0,
      },
      projects: [
        {
          id: "p1",
          name: "proj",
          directory: "/tmp/proj",
          entrySessionId: "s1",
          activity: "idle",
          machine: "local",
          branch: "main",
        },
      ],
      sessions: [
        {
          id: "s1",
          name: "coordinator",
          agent: "coordinator",
          harness: "claude",
          provider: null,
          model: null,
          status: "idle",
          executionState: "completed",
          projectId: "p1",
          parentId: null,
          runtime: "hc",
          machine: "local",
          worktree: "/tmp/proj",
          repositoryRoot: "/tmp/proj",
          git: { branch: "main", pushed: true, saved: true, why: "" },
          createdAt: Date.now() - 60_000,
          lastActive: Date.now() - 10_000,
          startedAt: Date.now() - 60_000,
          exitedAt: null,
          task: "ORIGINAL_TASK_PROMPT",
          summary: "Ready",
          isEntry: true,
          needsYou: false,
        },
      ],
      timelines: [],
      peeks: {},
    }

    fs.writeFileSync(path.join(home, "web-demo-state.json"), JSON.stringify(demoState), "utf8")

    const bridge = createVibestBridge({ vibestHome: home, repositoryRoot: home, demoMode: true, safeActions: true })

    try {
      const before = await bridge.getTimeline("p1", "s1")
      expect(before.map((e) => e.content)).toEqual(["ORIGINAL_TASK_PROMPT"])

      await bridge.sendToSession("s1", "follow up", [])
      const after = await bridge.getTimeline("p1", "s1")
      expect(after.map((e) => e.content)).toEqual(["ORIGINAL_TASK_PROMPT", "follow up"])
    } finally {
      bridge.stop()
    }
  })

  it("B6: returns HTTP 400 instead of 500 on malformed percent-encoding in route params", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-b6-"))
    tempDirs.push(home)
    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const badUri = await fetch(`${server.url}/api/projects/%E0%A4%A/files`)
    expect(badUri.status).toBe(400)
  })

  it("serves compiled Tailwind v4 and coss ui CSS tokens from dist/styles.css", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vbweb-css-"))
    tempDirs.push(home)
    const server = await createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
    servers.push(server)

    const cssRes = await fetch(`${server.url}/styles.css`)
    expect(cssRes.status).toBe(200)
    const css = await cssRes.text()
    expect(css).toContain("--background")
    expect(css).toContain("--sidebar")
  })
})
