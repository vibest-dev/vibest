import fs from "node:fs"
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
import { hasStructuredVibestTags, parseVibestMessageBlocks } from "../src/xml-parser.ts"

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

    expect(hasStructuredVibestTags(raw)).toBe(true)
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

    const server = createWebServer({ port: 0, vibestHome: home, demoMode: true, safeActions: true })
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Ship it", attachments: ["artifacts/demo.html"] }),
    })

    expect(sendRes.status).toBe(200)

    const saveRes = await fetch(`${server.url}/api/projects/${projectId}/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "artifacts/saved.excalidraw", content: '{"elements":[]}' }),
    })

    expect(saveRes.status).toBe(200)
    expect(readProjectTextFile(home, projectId, "artifacts/saved.excalidraw")).toBe('{"elements":[]}')

    const intRes = await fetch(`${server.url}/api/sessions/sub-1/interrupt`, { method: "POST" })
    expect(intRes.status).toBe(200)

    const archRes = await fetch(`${server.url}/api/sessions/sub-1/archive`, { method: "POST" })
    expect(archRes.status).toBe(200)
  })
})
