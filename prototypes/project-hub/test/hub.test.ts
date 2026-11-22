import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseCliArgs, runCli } from "../src/cli.ts"
import { HubDatabase } from "../src/database.ts"
import { renderSafeMarkdownHtml } from "../src/markdown-safe.ts"
import { matchNormalizedQuoteAcrossTextNodes } from "../src/quote-dom.ts"
import { seedDefaultDemoProject } from "../src/seed.ts"
import { createHubServer } from "../src/server.ts"
import { importVibestProjectReadOnly } from "../src/vibest-import.ts"
import {
  WhiteboardAutoSaver,
  computeWhiteboardSceneDigest,
  isWhiteboardInteractionActive,
} from "../src/whiteboard-sync.ts"
import { formatWorkspaceHash, parseWorkspaceHash } from "../src/workspace-hash.ts"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vibest-hub-${prefix}-`))
}

function extractRenderedTextChunks(html: string): string[] {
  const chunks: string[] = []
  let current = ""

  const rewriter = new HTMLRewriter().on("*", {
    text(textPart) {
      current += textPart.text

      if (textPart.lastInTextNode) {
        if (current.length > 0) {
          chunks.push(current)
        }

        current = ""
      }
    },
  })

  void rewriter.transform(new Response(html)).text()

  return chunks
}

async function extractRenderedTextChunksAsync(html: string): Promise<string[]> {
  const chunks: string[] = []
  let current = ""

  const rewriter = new HTMLRewriter().on("*", {
    text(textPart) {
      current += textPart.text

      if (textPart.lastInTextNode) {
        const decoded = current
          .replaceAll("&#39;", "'")
          .replaceAll("&quot;", '"')
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&")

        if (decoded.length > 0) {
          chunks.push(decoded)
        }

        current = ""
      }
    },
  })

  await rewriter.transform(new Response(html)).text()

  return chunks
}

describe("HubDatabase event ledger & projection invariants", () => {
  test("enforces append-only event table triggers and rebuilds projections deterministically", () => {
    const dir = makeTempDir("ledger")
    const hub = new HubDatabase(dir)

    try {
      const project = seedDefaultDemoProject(hub)
      const boardBefore = hub.getBoard(project.id)
      expect(boardBefore.needsYou.length).toBe(5)
      expect(boardBefore.inProgress.length).toBe(3)
      expect(boardBefore.doneTasks.length).toBe(1)

      expect(() => {
        hub.db.exec("UPDATE event SET type = 'tampered' WHERE seq = 1")
      }).toThrow(/event is append-only/)

      expect(() => {
        hub.db.exec("DELETE FROM event WHERE seq = 1")
      }).toThrow(/event is append-only/)

      const replayedCount = hub.rebuildProjectionFromLedger()
      expect(replayedCount).toBeGreaterThan(10)

      const boardAfter = hub.getBoard(project.id)
      expect(boardAfter.needsYou.map((i) => i.id)).toEqual(boardBefore.needsYou.map((i) => i.id))
      expect(boardAfter.inProgress.map((t) => t.task.id)).toEqual(boardBefore.inProgress.map((t) => t.task.id))
    } finally {
      hub.close()
    }
  })

  test("derives Needs You strictly from requested artifacts + blocked sessions and clears on review/unblock", () => {
    const dir = makeTempDir("needs-you")
    const hub = new HubDatabase(dir)

    try {
      const project = seedDefaultDemoProject(hub)
      expect(hub.getBoard(project.id).needsYou.length).toBe(5)

      hub.answerQuestion("art-hub-spec", "delivery-mode", ["opt-in-send"])

      const reviewRes = hub.submitReview({
        artifactId: "art-hub-spec",
        verdict: "approved",
        reviewerNote: "Ship with opt-in send.",
      })

      expect(reviewRes.artifact.reviewStatus).toBe("approved")
      expect(reviewRes.targetSessionId).toBe("ses-entry-coord")
      expect(reviewRes.agentPayload).toContain('verdict="approved"')
      expect(reviewRes.agentPayload).toContain("opt-in-send")

      expect(hub.getBoard(project.id).needsYou.length).toBe(4)

      const changesRes = hub.submitReview({
        artifactId: "art-triage-ui",
        verdict: "changes_requested",
        reviewerNote: "Tighten sidebar spacing.",
      })

      expect(changesRes.artifact.reviewStatus).toBe("changes_requested")
      expect(changesRes.targetSessionId).toBe("ses-ui-worker")
      expect(hub.getBoard(project.id).needsYou.length).toBe(3)

      hub.updateSessionStatus("ses-blocked-racknerd", "running")
      expect(hub.getBoard(project.id).needsYou.length).toBe(2)
    } finally {
      hub.close()
    }
  })

  test("persists DOM, Region, Whiteboard, and Quote anchors across projection rebuilds", () => {
    const dir = makeTempDir("anchors")
    const hub = new HubDatabase(dir)

    try {
      seedDefaultDemoProject(hub)

      const domPin = hub.addCommentThread({
        artifactId: "art-triage-ui",
        body: "Make badge pulse only on new events",
        anchor: {
          kind: "dom",
          variantId: "option-a",
          selector: "#sidebar-needs-badge",
          tagName: "span",
          textPreview: "3 Needs You",
          xRatio: 0.14,
          yRatio: 0.05,
          wRatio: 0.06,
          hRatio: 0.03,
        },
      })

      const regionPin = hub.addCommentThread({
        artifactId: "art-triage-ui",
        body: "Align chart baseline with telemetry cards",
        anchor: {
          kind: "region",
          variantId: "option-a",
          regionStyle: "circle",
          xRatio: 0.3,
          yRatio: 0.62,
          wRatio: 0.55,
          hRatio: 0.25,
        },
      })

      const wbPin = hub.addCommentThread({
        artifactId: "art-arch-whiteboard",
        body: "Show WebSocket push fan-out count",
        anchor: {
          kind: "whiteboard",
          elementIds: ["node-hub", "node-browser"],
          elementLabels: ["Bun Project & Artifact Hub", "Web Review Studio"],
          x: 740,
          y: 120,
        },
      })

      expect(domPin.pinNumber).toBe(2)
      expect(regionPin.pinNumber).toBe(3)
      expect(wbPin.pinNumber).toBe(2)

      hub.rebuildProjectionFromLedger()

      const reloadedHtmlThreads = hub.listCommentThreads("art-triage-ui")
      expect(reloadedHtmlThreads.length).toBe(3)
      expect(reloadedHtmlThreads[1]?.anchor.kind).toBe("dom")
      expect(reloadedHtmlThreads[2]?.anchor.kind).toBe("region")

      const { payload } = hub.buildAgentReviewPayload("art-triage-ui", "changes_requested")
      expect(payload).toContain('selector="#sidebar-needs-badge"')
      expect(payload).toContain('style="circle"')
    } finally {
      hub.close()
    }
  })
})

describe("Read-only external Vibest project import & CLI", () => {
  test("imports Vibest project directory and external SQLite strictly read-only without mutating source", () => {
    const extDir = makeTempDir("ext-vibest")
    const projUuid = "11111111-2222-3333-4444-555555555555"
    const projFolder = path.join(extDir, projUuid)
    fs.mkdirSync(path.join(projFolder, "memories"), { recursive: true })
    fs.mkdirSync(path.join(projFolder, "docs"), { recursive: true })
    const prefPath = path.join(projFolder, "preferences.md")
    fs.writeFileSync(prefPath, "# External Preferences\n- Strict read-only test\n", "utf8")
    fs.writeFileSync(path.join(projFolder, "memories", "MEMORY.md"), "# External Memory\n", "utf8")
    fs.writeFileSync(path.join(projFolder, "docs", "overview.md"), "# External Doc\n", "utf8")

    const extDbPath = path.join(extDir, "vibest.db")
    const extDb = new Database(extDbPath, { create: true })
    extDb.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, directory TEXT, entry_session_id TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_session_id TEXT, agent TEXT, name TEXT, directory TEXT, created_at INTEGER, ended_at INTEGER, process_id INTEGER);
      CREATE TABLE process (session_id TEXT, id INTEGER, harness TEXT, model TEXT, ended_at INTEGER, PRIMARY KEY (session_id, id));
      CREATE TABLE execution (session_id TEXT, id INTEGER, owner INTEGER, PRIMARY KEY (session_id, id));
    `)
    extDb.query("INSERT INTO project VALUES (?, ?, ?)").run(projUuid, "/tmp/repo", "ses-ext-entry")
    extDb
      .query("INSERT INTO session VALUES (?, ?, NULL, 'default', 'ext-coord', '/tmp/repo', 1000, NULL, 1)")
      .run("ses-ext-entry", projUuid)
    extDb.query("INSERT INTO process VALUES ('ses-ext-entry', 1, 'claude', 'claude-opus-4-6', NULL)").run()
    extDb.query("INSERT INTO execution VALUES ('ses-ext-entry', 1, 1)").run()
    extDb.close()

    const beforeStat = fs.statSync(prefPath)

    const hubDir = makeTempDir("hub-import")
    const hub = new HubDatabase(hubDir)

    try {
      const imported = importVibestProjectReadOnly(hub, {
        name: "imported-workspace",
        vibestProjectDir: projFolder,
        vibestDbPath: extDbPath,
      })

      expect(imported.copiedKnowledgeFiles).toBe(3)
      expect(imported.importedSessions).toBe(1)

      hub.writeKnowledgeFile(imported.project.id, "preferences.md", "# Edited Inside Hub Only\n")
      expect(fs.readFileSync(prefPath, "utf8")).toBe("# External Preferences\n- Strict read-only test\n")
      expect(fs.statSync(prefPath).mtimeMs).toBe(beforeStat.mtimeMs)
    } finally {
      hub.close()
    }
  })

  test("executes companion CLI commands end-to-end and broadcasts over HTTP/WebSocket", async () => {
    const hubDir = makeTempDir("cli-server")
    const sampleMd = path.join(hubDir, "cli-spec.md")
    fs.writeFileSync(sampleMd, "# CLI Uploaded Spec\n\nReady for review.\n", "utf8")

    const running = await createHubServer({
      port: 0,
      hostname: "127.0.0.1",
      dataDir: hubDir,
      skipClientBuild: true,
    })

    const wsEvents: string[] = []
    const ws = new WebSocket(`${running.url.replace("http://", "ws://")}/ws`)
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    })
    ws.onmessage = (ev) => {
      wsEvents.push(String(ev.data))
    }

    try {
      expect(
        await runCli([
          "task",
          "create",
          "--title",
          "CLI Workstream",
          "--summary",
          "Created from CLI test",
          "--data-dir",
          hubDir,
          "--server",
          running.url,
        ]),
      ).toBe(0)

      expect(
        await runCli([
          "artifact",
          "put",
          "markdown",
          sampleMd,
          "--title",
          "CLI Spec Deliverable",
          "--slug",
          "cli-spec-deliverable",
          "--request-review",
          "--data-dir",
          hubDir,
          "--server",
          running.url,
        ]),
      ).toBe(0)

      expect(await runCli(["board", "--data-dir", hubDir, "--json"])).toBe(0)
      expect(await runCli(["artifact", "comments", "cli-spec-deliverable", "--data-dir", hubDir])).toBe(0)

      const boardRes = await fetch(`${running.url}/api/projects/proj-vibest-core/board`)
      expect(boardRes.ok).toBe(true)
      const boardJson = await boardRes.json()
      expect(boardJson.needsYou.length).toBe(6)
      expect(wsEvents.length).toBeGreaterThanOrEqual(2)
    } finally {
      ws.close()
      running.stop()
    }
  })
})

describe("QA regression checks (B1-B6 & UX polish)", () => {
  test("B1: sandboxes HTML preview without allow-same-origin, sanitizes Markdown XSS, and blocks cross-origin/non-JSON CSRF", async () => {
    const hubDir = makeTempDir("b1-sec")

    const running = await createHubServer({
      port: 0,
      hostname: "127.0.0.1",
      dataDir: hubDir,
      skipClientBuild: true,
    })

    try {
      const previewRes = await fetch(`${running.url}/api/artifacts/art-triage-ui/preview`)
      expect(previewRes.status).toBe(200)
      const csp = previewRes.headers.get("content-security-policy") ?? ""
      expect(csp).toBe("sandbox allow-scripts")
      expect(csp).not.toContain("allow-same-origin")
      const previewHtml = await previewRes.text()
      expect(previewHtml).toContain('data-vibest-hub-bridge="true"')
      expect(previewHtml).toContain("vibest-hub-bridge")

      const hostileMarkdown = [
        "# Security Spec",
        "",
        "<script>window.pwned = true</script>",
        "",
        '<iframe src="http://127.0.0.1:4310/api/projects"></iframe>',
        "",
        '<object data="evil.swf"></object><embed src="evil.swf" />',
        "",
        '<img src="data:invalid" title=">" onerror="document.body.dataset.mdXssTriggered=\'yes\'">',
        "",
        "[js-link](javascript:alert(1))",
        "[encoded-js](&#x6a;avascript:alert(1))",
        "[vb-link](vbscript:msgbox(1))",
        "[data-html](data:text/html,<script>alert(1)</script>)",
        "[safe-link](https://github.com/vibest-dev/vibest)",
        "",
        "| Gate | Status |",
        "| :--- | :--- |",
        "| **Build** | `passed` |",
      ].join("\n")

      const sanitized = renderSafeMarkdownHtml(hostileMarkdown)
      expect(sanitized).not.toContain("<script")
      expect(sanitized).not.toContain("window.pwned")
      expect(sanitized).not.toContain("<iframe")
      expect(sanitized).not.toContain("<object")
      expect(sanitized).not.toContain("<embed")
      expect(sanitized).not.toContain("onerror")
      expect(sanitized).not.toContain("javascript:")
      expect(sanitized).not.toContain("vbscript:")
      expect(sanitized).not.toContain("data:text/html")
      expect(sanitized).not.toContain("data:invalid")
      expect(sanitized).toContain('<a href="https://github.com/vibest-dev/vibest">safe-link</a>')
      expect(sanitized).toContain("<a>js-link</a>")
      expect(sanitized).toContain("<table>")
      expect(sanitized).toContain("<strong>Build</strong>")

      const evilOriginRes = await fetch(`${running.url}/api/artifacts/art-triage-ui/review`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ verdict: "approved", reviewerNote: "forged" }),
      })

      expect(evilOriginRes.status).toBe(403)

      const sandboxOpaqueOriginRes = await fetch(`${running.url}/api/artifacts/art-triage-ui/review`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "null",
        },
        body: JSON.stringify({ verdict: "approved", reviewerNote: "from-sandbox-iframe" }),
      })

      expect(sandboxOpaqueOriginRes.status).toBe(403)

      const textPlainCsrfRes = await fetch(`${running.url}/api/artifacts/art-triage-ui/review`, {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify({ verdict: "approved", reviewerNote: "simple-post" }),
      })

      expect(textPlainCsrfRes.status).toBe(415)

      const validSameOriginRes = await fetch(`${running.url}/api/artifacts/art-triage-ui/answers`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: running.url,
        },
        body: JSON.stringify({ questionId: "preferred-layout", selectedOptionIds: ["option-a"] }),
      })

      expect(validSameOriginRes.status).toBe(200)
    } finally {
      running.stop()
    }
  })

  test("B2 & Knowledge paths: enforces HUB_DATA_DIR/projects containment and blocks trailing-slash directory shadowing", async () => {
    const outerTmp = makeTempDir("b2-isolation")
    const hubDir = path.join(outerTmp, "hub-data")
    const escapedDir = path.join(outerTmp, "escaped-outside")

    const running = await createHubServer({
      port: 0,
      hostname: "127.0.0.1",
      dataDir: hubDir,
      skipClientBuild: true,
    })

    try {
      expect(() => running.hubDb.projectDir("../../escaped-direct")).toThrow(/Invalid projectId/)

      const relEscape = path.relative(path.join(hubDir, "projects"), escapedDir)

      const escapeRes = await fetch(`${running.url}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: relEscape,
          title: "Escaped",
          kind: "html",
          content: "<p>escaped</p>",
        }),
      })

      expect(escapeRes.status).toBe(404)
      expect(fs.existsSync(escapedDir)).toBe(false)

      const badSlugRes = await fetch(`${running.url}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-vibest-core",
          slug: "../../outside-slug",
          title: "Bad Slug",
          kind: "markdown",
          content: "# bad",
        }),
      })

      expect(badSlugRes.status).toBe(400)

      const badExtraRes = await fetch(`${running.url}/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-vibest-core",
          title: "Bad Extra",
          kind: "html",
          content: "<p>ok</p>",
          extraFiles: [{ fileName: "../evil.html", content: "<p>evil</p>" }],
        }),
      })

      expect(badExtraRes.status).toBe(400)

      const createdProjRes = await fetch(`${running.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Blank Knowledge Check", description: "test" }),
      })

      const createdProjJson = await createdProjRes.json()
      const blankProjId = String(createdProjJson.project.id)

      for (const badRelPath of ["memories/", "docs/", "../hub.sqlite", "memories/../../hub.sqlite", "docs/no-ext"]) {
        const badRes = await fetch(`${running.url}/api/projects/${blankProjId}/knowledge`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ relativePath: badRelPath, content: "clobber" }),
        })

        expect(badRes.status).toBe(400)
      }

      const validKnowledgeRes = await fetch(`${running.url}/api/projects/${blankProjId}/knowledge`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativePath: "memories/architecture-note.md", content: "# Valid Note\n" }),
      })

      expect(validKnowledgeRes.status).toBe(200)

      const listRes = await fetch(`${running.url}/api/projects/${blankProjId}/knowledge`)
      expect(listRes.status).toBe(200)
      const listJson = await listRes.json()
      expect(
        listJson.files.some((f: { relativePath: string }) => f.relativePath === "memories/architecture-note.md"),
      ).toBe(true)
    } finally {
      running.stop()
    }
  })

  test("B3: WhiteboardAutoSaver tracks version/versionNonce/isDeleted and defers mid-drag frames until pointer release", async () => {
    const midDragBox = [
      {
        id: "rect-draw-1",
        type: "rectangle",
        x: 531,
        y: 334,
        width: 13,
        height: 11,
        backgroundColor: "transparent",
        version: 2,
        versionNonce: 102,
        isDeleted: false,
      },
    ]

    const finishedBox = [
      {
        id: "rect-draw-1",
        type: "rectangle",
        x: 531,
        y: 334,
        width: 260,
        height: 110,
        backgroundColor: "#dcfce7",
        version: 28,
        versionNonce: 984,
        isDeleted: false,
      },
    ]

    expect(computeWhiteboardSceneDigest(midDragBox, "#ffffff")).not.toBe(
      computeWhiteboardSceneDigest(finishedBox, "#ffffff"),
    )

    expect(isWhiteboardInteractionActive({ newElement: { id: "rect-draw-1" }, cursorButton: "down" })).toBe(true)
    expect(isWhiteboardInteractionActive({ draggingElement: { id: "rect-draw-1" } })).toBe(true)
    expect(isWhiteboardInteractionActive({ resizingElement: { id: "rect-draw-1" } })).toBe(true)
    expect(isWhiteboardInteractionActive({ editingElement: { id: "rect-draw-1" } })).toBe(true)
    expect(isWhiteboardInteractionActive({ cursorButton: "up", newElement: null, resizingElement: null })).toBe(false)

    const savedPayloads: string[] = []
    const statuses: string[] = []

    const saver = new WhiteboardAutoSaver(
      async (payload) => {
        savedPayloads.push(payload)
      },
      (status) => {
        statuses.push(status)
      },
      25,
    )

    saver.resetBaseline([], "#ffffff")
    saver.recordChange(midDragBox, { newElement: { id: "rect-draw-1" }, cursorButton: "down" })
    await Bun.sleep(45)
    expect(savedPayloads.length).toBe(0)

    saver.recordChange(finishedBox, { newElement: null, cursorButton: "up" })
    await Bun.sleep(45)
    expect(savedPayloads.length).toBe(1)

    const savedScene = JSON.parse(savedPayloads[0] ?? "{}")
    expect(savedScene.elements[0]?.width).toBe(260)
    expect(savedScene.elements[0]?.height).toBe(110)
    expect(savedScene.elements[0]?.backgroundColor).toBe("#dcfce7")
    expect(statuses.at(-1)).toBe("saved")

    const resizedAndColored = [
      {
        ...finishedBox[0]!,
        width: 340,
        strokeColor: "#1d4ed8",
        version: 29,
        versionNonce: 1105,
      },
    ]

    saver.recordChange(resizedAndColored, { resizingElement: null, cursorButton: "up" })
    await Bun.sleep(45)
    expect(savedPayloads.length).toBe(2)
    expect(JSON.parse(savedPayloads[1] ?? "{}").elements[0]?.width).toBe(340)
  })

  test("B4: matches normalized quotes across inline formatting boundaries without touching HTML tags", async () => {
    const dir = makeTempDir("b4-quotes")
    const hub = new HubDatabase(dir)

    try {
      seedDefaultDemoProject(hub)
      const specContent = hub.readArtifactContent("art-hub-spec")
      const threads = hub.listCommentThreads("art-hub-spec")
      const seededThread = threads[0]
      expect(seededThread?.anchor.kind).toBe("quote")

      const cleanHtml = renderSafeMarkdownHtml(specContent)
      const textChunks = await extractRenderedTextChunksAsync(cleanHtml)

      const seededQuote = seededThread?.anchor.kind === "quote" ? seededThread.anchor.quote : ""
      const matchedSlices = matchNormalizedQuoteAcrossTextNodes(textChunks, seededQuote)
      expect(matchedSlices.length).toBeGreaterThanOrEqual(3)

      const reconstructed = matchedSlices
        .map((s) => (textChunks[s.nodeIndex] ?? "").slice(s.startOffset, s.endOffset))
        .join("")
        .replace(/\s+/g, " ")
        .trim()

      expect(reconstructed).toBe(seededQuote)

      const tagHazardHtml = renderSafeMarkdownHtml("This **important** table shows `code` clearly.")
      const hazardChunks = extractRenderedTextChunks(tagHazardHtml)
      expect(matchNormalizedQuoteAcrossTextNodes(hazardChunks, "strong")).toEqual([])
      const tableMatch = matchNormalizedQuoteAcrossTextNodes(hazardChunks, "table")
      expect(tableMatch.length).toBe(1)

      const matchedWord = (hazardChunks[tableMatch[0]!.nodeIndex] ?? "").slice(
        tableMatch[0]!.startOffset,
        tableMatch[0]!.endOffset,
      )

      expect(matchedWord).toBe("table")
    } finally {
      hub.close()
    }
  })

  test("B5: clears stale lastReviewPayload on v2 publish and recomputes live payload when comments or answers change", async () => {
    const hubDir = makeTempDir("b5-payload")

    const running = await createHubServer({
      port: 0,
      hostname: "127.0.0.1",
      dataDir: hubDir,
      skipClientBuild: true,
    })

    const capturedCliLogs: string[] = []
    const origLog = console.log

    try {
      const reviewV1 = await fetch(`${running.url}/api/artifacts/art-pr-613-verify/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "changes_requested", reviewerNote: "v1 feedback" }),
      })

      expect(reviewV1.status).toBe(200)

      const publishV2 = await fetch(`${running.url}/api/artifacts/art-pr-613-verify/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "# Updated v2 verify summary", publishNewVersion: true, requestReview: true }),
      })

      expect(publishV2.status).toBe(200)

      const addV2Comment = await fetch(`${running.url}/api/artifacts/art-pr-613-verify/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "New blocker on v2",
          anchor: { kind: "verify", section: "pnpm build" },
        }),
      })

      expect(addV2Comment.status).toBe(201)

      const detailRes = await fetch(`${running.url}/api/artifacts/art-pr-613-verify`)
      const detail = await detailRes.json()
      expect(detail.artifact.version).toBe(2)
      expect(detail.agentPayloadPreview).toContain('version="2"')
      expect(detail.agentPayloadPreview).toContain("New blocker on v2")
      expect(detail.agentPayloadPreview).not.toContain("v1 feedback")

      console.log = (...args: Array<string | number | boolean | null | undefined>) => {
        capturedCliLogs.push(args.map((a) => String(a)).join(" "))
      }

      expect(await runCli(["artifact", "comments", "art-pr-613-verify", "--json", "--data-dir", hubDir])).toBe(0)
      const cliCommentsJson = JSON.parse(capturedCliLogs.at(-1) ?? "{}")
      expect(cliCommentsJson.version).toBe(2)
      expect(cliCommentsJson.agentPayload).toContain('version="2"')
      expect(cliCommentsJson.agentPayload).toContain("New blocker on v2")

      running.hubDb.rebuildProjectionFromLedger()
      const rebuiltPayload = running.hubDb.getCurrentReviewPayload("art-pr-613-verify")
      expect(rebuiltPayload.payload).toContain('version="2"')
      expect(rebuiltPayload.payload).toContain("New blocker on v2")
    } finally {
      console.log = origLog
      running.stop()
    }
  })

  test("B6 & UX polish: CLI boolean flags never consume positionals, hash route persists artifact, circle CSS uses 50%", async () => {
    const parsed = parseCliArgs(["--json", "project", "ls"])
    expect(parsed.positionals).toEqual(["project", "ls"])
    expect(parsed.flags.get("json")).toEqual(["true"])

    const parsedHelpShort = parseCliArgs(["-h", "board"])
    expect(parsedHelpShort.flags.get("help")).toEqual(["true"])
    expect(parsedHelpShort.positionals).toEqual(["board"])

    const hubDir = makeTempDir("b6-cli")
    const sampleHtml = path.join(hubDir, "flag-order.html")
    fs.writeFileSync(sampleHtml, "<div>Flag order test</div>", "utf8")

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: Array<string | number | boolean | null | undefined>) => {
      logs.push(args.map((a) => String(a)).join(" "))
    }

    try {
      expect(await runCli(["--data-dir", hubDir, "--json", "project", "ls"])).toBe(0)
      const parsedProjects = JSON.parse(logs.at(-1) ?? "null")
      expect(Array.isArray(parsedProjects)).toBe(true)

      logs.length = 0
      expect(await runCli(["--data-dir", hubDir, "--json", "board"])).toBe(0)
      const parsedBoard = JSON.parse(logs.at(-1) ?? "null")
      expect(parsedBoard.project.id).toBe("proj-vibest-core")

      logs.length = 0
      expect(
        await runCli([
          "artifact",
          "put",
          "--request-review",
          "html",
          sampleHtml,
          "--slug",
          "flag-order-html",
          "--json",
          "--data-dir",
          hubDir,
        ]),
      ).toBe(0)
      const published = JSON.parse(logs.at(-1) ?? "null")
      expect(published.reviewStatus).toBe("requested")

      logs.length = 0
      expect(await runCli(["-h"])).toBe(0)
      expect(logs.join("\n")).toContain("Usage:")
    } finally {
      console.log = origLog
    }

    const encodedHash = formatWorkspaceHash("proj-vibest-core", "artifacts", "art-arch-whiteboard")
    expect(parseWorkspaceHash(encodedHash)).toEqual({
      projectId: "proj-vibest-core",
      tab: "artifacts",
      artifactId: "art-arch-whiteboard",
    })

    const cssSource = fs.readFileSync(path.resolve(import.meta.dir, "../src/client/styles.css"), "utf8")
    expect(cssSource).toMatch(/\.annotation-region\.circle\s*\{\s*border-radius:\s*50%;\s*\}/)
  })
})
