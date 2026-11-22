import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runCli } from "../src/cli.ts"
import { HubDatabase } from "../src/database.ts"
import { seedDefaultDemoProject } from "../src/seed.ts"
import { createHubServer } from "../src/server.ts"
import { importVibestProjectReadOnly } from "../src/vibest-import.ts"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vibest-hub-${prefix}-`))
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
      expect(wsEvents.length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
      running.stop()
    }
  })
})
