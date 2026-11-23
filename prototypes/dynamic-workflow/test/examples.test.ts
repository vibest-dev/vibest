import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import fanoutAudit from "../examples/01-fanout-audit.ts"
import implementReviewFix from "../examples/02-implement-review-fix.ts"
import checkpointResume from "../examples/03-checkpoint-resume.ts"
import type { Json } from "../src/driver.ts"
import { FakeVibestDriver, type FakeAnswer } from "../src/fake-driver.ts"
import { Journal } from "../src/journal.ts"
import { runWorkflow } from "../src/workflow.ts"

const fenced = (value: Json): FakeAnswer => ({ text: `Here it is.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` })

describe("01 fan-out audit", () => {
  test("audits every module from every angle and merges duplicate findings", async () => {
    const driver = new FakeVibestDriver((turn) => {
      const shared = {
        file: "core/inbox.ts",
        line: 40,
        severity: turn.title.includes("concurrency") ? "high" : "low",
        summary: "race",
      }

      const own = { file: `${turn.title.split(" ")[1]}/x.ts`, line: 1, severity: "medium", summary: "leak" }

      return fenced({ findings: turn.title.includes("error handling") ? [own] : [shared] })
    })

    const report = await runWorkflow(fanoutAudit, { driver, args: { modules: ["core", "cli"] } })

    expect(report.status).toBe("completed")
    expect(driver.calls.filter((call) => call.startsWith("spawn"))).toHaveLength(6)
    expect(report.result).toMatchObject({
      findings: [
        {
          file: "core/inbox.ts",
          line: 40,
          severity: "high",
          angles: ["correctness", "concurrency and cancellation", "correctness", "concurrency and cancellation"],
        },
        { file: "cli/x.ts", severity: "medium" },
        { file: "core/x.ts", severity: "medium" },
      ],
    })
  })
})

describe("02 implement, review, fix", () => {
  test("a failing gate goes back to the implementer and a rejection starts another round", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-worktree-"))

    const driver = new FakeVibestDriver(async (turn) => {
      if (turn.title === "Implement change") {
        if (turn.turn === 2) await Bun.write(path.join(worktree, "fixed"), "")

        return fenced({ worktree, branch: "feat/x", commit: `c${turn.turn}` })
      }

      return fenced(turn.turn === 1 ? { approved: false, issues: ["missing test"] } : { approved: true, issues: [] })
    })

    const report = await runWorkflow(implementReviewFix, {
      driver,
      args: { task: "Add x", gate: "test -f fixed" },
    })

    expect(report.result).toEqual({ approved: true, rounds: 3, branch: "feat/x", commit: "c3" })
    expect(driver.history("s1")[2]).toContain("The gate `test -f fixed` fails")
    expect(driver.history("s1")[4]).toContain("missing test")
    expect(driver.calls.filter((call) => call.startsWith("spawn"))).toEqual([
      "spawn s1 Implement change",
      "spawn s2 Review change",
    ])
    expect(report.sessions).toEqual([
      { id: "s1", title: "Implement change", state: "kept" },
      { id: "s2", title: "Review change", state: "archived" },
    ])
  })
})

describe("03 checkpoint resume", () => {
  test("a rerun after a usage limit skips the finished steps and resumes the limited agent", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "workflow-")), "state.json")
    let limited = true

    const driver = new FakeVibestDriver((turn): FakeAnswer => {
      if (turn.title === "Plan research") return fenced({ items: ["why", "how"] })

      if (turn.title === "Research how" && limited) return { fail: "rate limit exceeded: try again later" }

      if (turn.title.startsWith("Research"))
        return fenced({ item: turn.title.slice("Research ".length), note: "noted" })

      return { text: "summary" }
    })

    const first = await runWorkflow(checkpointResume, {
      driver,
      args: { topic: "inboxes" },
      journal: await Journal.open(file),
    })

    expect(first.status).toBe("escalated")
    expect(first.escalation).toMatchObject({ kind: "limit", title: "Research how" })
    limited = false
    const before = driver.calls.length

    const second = await runWorkflow(checkpointResume, {
      driver,
      args: { topic: "inboxes" },
      journal: await Journal.open(file),
    })

    expect(second.status).toBe("completed")
    expect(second.result).toMatchObject({ notes: [{ item: "why" }, { item: "how" }], summary: "summary" })
    expect(driver.calls.slice(before)).toEqual(["send s3", "archive s3", "spawn s4 Summarise research", "archive s4"])
  })
})
