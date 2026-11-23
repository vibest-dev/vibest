import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Schema } from "effect"

import type { Json } from "../src/driver.ts"
import { FakeVibestDriver, type FakeAnswer, type FakeTurn } from "../src/fake-driver.ts"
import { Journal } from "../src/journal.ts"
import { WORKER_RULES, runWorkflow, type Workflow } from "../src/workflow.ts"

const Count = Schema.toStandardSchemaV1(Schema.Struct({ count: Schema.Number }))

const fenced = (value: Json): FakeAnswer => ({ text: `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` })

const tempJournal = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), "workflow-")), "state.json")

const spawns = (driver: FakeVibestDriver) => driver.calls.filter((call) => call.startsWith("spawn"))

describe("parallel", () => {
  test("returns results in input order and keeps to its concurrency", async () => {
    let running = 0
    let peak = 0

    const driver = new FakeVibestDriver(async (turn) => {
      running += 1
      peak = Math.max(peak, running)
      await Bun.sleep(turn.title.endsWith("a") ? 15 : 1)
      running -= 1

      return { text: turn.title }
    })

    const report = await runWorkflow(
      (wf) =>
        wf.parallel(["a", "b", "c", "d"], (item) => wf.agent({ title: `Item ${item}`, prompt: item }), {
          concurrency: 2,
        }),
      { driver },
    )

    expect(report.result).toEqual(["Item a", "Item b", "Item c", "Item d"])
    expect(peak).toBe(2)
  })

  test("a failure interrupts the running siblings and starts no more", async () => {
    const driver = new FakeVibestDriver((turn): FakeAnswer =>
      turn.title === "Item b" ? { fail: "the build broke", delay: 5 } : { hang: true },
    )

    const report = await runWorkflow(
      (wf) =>
        wf.parallel(["a", "b", "c", "d"], (item) => wf.agent({ title: `Item ${item}`, prompt: item }), {
          concurrency: 3,
        }),
      { driver },
    )

    expect(report.status).toBe("failed")
    expect(report.error).toContain("the build broke")
    expect(driver.calls).toContain("interrupt s1")
    expect(driver.calls).toContain("interrupt s3")
    expect(spawns(driver)).toHaveLength(3)
  })
})

describe("agents", () => {
  test("a session serialises its turns and keeps its history", async () => {
    const driver = new FakeVibestDriver((turn) => ({
      text: `turn ${turn.turn} saw ${turn.history.length - 1} earlier`,
      delay: 3,
    }))

    const report = await runWorkflow(
      async (wf) => {
        const reviewer = wf.session({ title: "Review", prompt: "You review." })

        return Promise.all([reviewer("first"), reviewer("second")])
      },
      { driver },
    )

    expect(report.result).toEqual(["turn 1 saw 0 earlier", "turn 2 saw 2 earlier"])
    expect(driver.calls).toEqual(["spawn s1 Review", "send s1", "archive s1"])
  })

  test("the first prompt carries the worker rules so the coordinator is not woken", async () => {
    const prompts: Array<string> = []

    const driver = new FakeVibestDriver((turn) => {
      prompts.push(turn.prompt)

      return { text: "ok" }
    })

    await runWorkflow((wf) => wf.agent({ title: "Check", prompt: "check it" }), { driver })

    expect(prompts[0]?.startsWith(WORKER_RULES)).toBe(true)
  })

  test("output that fails its schema gets one repair turn", async () => {
    const driver = new FakeVibestDriver((turn): FakeAnswer =>
      turn.turn === 1 ? fenced({ count: "three" }) : fenced({ count: 3 }),
    )

    const report = await runWorkflow((wf) => wf.agent({ title: "Count", prompt: "count", schema: Count }), { driver })

    expect(report.result).toEqual({ count: 3 })
    expect(driver.history("s1")[2]).toContain("count: Expected number")
    expect(report.trace.map((event) => event.kind)).toContain("repair")
  })

  test("output still invalid after the repair turn fails the workflow", async () => {
    const driver = new FakeVibestDriver(() => ({ text: "no json here" }))
    const report = await runWorkflow((wf) => wf.agent({ title: "Count", prompt: "count", schema: Count }), { driver })

    expect(report.status).toBe("failed")
    expect(report.error).toContain("no valid output after a repair turn")
    expect(driver.calls).toEqual(["spawn s1 Count", "send s1"])
  })

  test("a blocked agent escalates and stays open", async () => {
    const driver = new FakeVibestDriver(() => ({ text: "BLOCKED: may I drop the table?" }))
    const report = await runWorkflow((wf) => wf.agent({ title: "Migrate", prompt: "migrate" }), { driver })

    expect(report.status).toBe("escalated")
    expect(report.escalation).toMatchObject({ kind: "blocked", session: "s1" })
    expect(report.sessions).toEqual([{ id: "s1", title: "Migrate", state: "open" }])
  })

  test("a usage limit escalates", async () => {
    const driver = new FakeVibestDriver(() => ({ fail: "usage limit reached: resets at 5pm" }))
    const report = await runWorkflow((wf) => wf.agent({ title: "Audit", prompt: "audit" }), { driver })

    expect(report.escalation).toMatchObject({ kind: "limit", session: "s1" })
  })

  test("read-only agents are archived and writing agents are kept", async () => {
    const driver = new FakeVibestDriver(() => ({ text: "done" }))

    const report = await runWorkflow(
      async (wf) => {
        await wf.agent({ title: "Review", prompt: "review" })
        await wf.agent({ title: "Implement", prompt: "build", writes: true })

        return null
      },
      { driver },
    )

    expect(report.sessions).toEqual([
      { id: "s1", title: "Review", state: "archived" },
      { id: "s2", title: "Implement", state: "kept" },
    ])
  })

  test("cancelling the run interrupts the running agents", async () => {
    const driver = new FakeVibestDriver(() => ({ hang: true }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("SIGINT")), 10)

    const report = await runWorkflow(
      (wf) => wf.parallel(["a", "b"], (item) => wf.agent({ title: item, prompt: item })),
      { driver, signal: controller.signal },
    )

    expect(report.status).toBe("cancelled")
    expect(driver.calls.filter((call) => call.startsWith("interrupt"))).toEqual(["interrupt s1", "interrupt s2"])
  })
})

describe("journal", () => {
  test("a restarted runner reattaches to an agent that was already working", async () => {
    const file = await tempJournal()
    const driver = new FakeVibestDriver(() => ({ text: "finished while the runner was down", delay: 5 }))
    const session = await driver.spawn({ title: "Long job", prompt: "work" })
    await (await Journal.open(file)).set("main/Long job/1", { session, after: 0, sent: true })

    const report = await runWorkflow((wf) => wf.agent({ title: "Long job", prompt: "work" }), {
      driver,
      journal: await Journal.open(file),
    })

    expect(report.result).toBe("finished while the runner was down")
    expect(spawns(driver)).toEqual(["spawn s1 Long job"])
    expect(report.trace.map((event) => event.kind)).toContain("reattach")
  })

  test("a step runs once and its value is replayed", async () => {
    const file = await tempJournal()
    const Modules = Schema.toStandardSchemaV1(Schema.Array(Schema.String))
    let runs = 0

    const script = (wf: Workflow) =>
      wf.step("modules", Modules, async () => {
        runs += 1

        return ["core", "cli"]
      })

    const driver = new FakeVibestDriver(() => ({ text: "" }))
    await runWorkflow(script, { driver, journal: await Journal.open(file) })
    const again = await runWorkflow(script, { driver, journal: await Journal.open(file) })

    expect(again.result).toEqual(["core", "cli"])
    expect(runs).toBe(1)
  })

  test("calls of the same agent title get their own journal keys", async () => {
    const driver = new FakeVibestDriver((turn: FakeTurn) => ({ text: turn.prompt.split("\n").at(-1) ?? "" }))

    const report = await runWorkflow(
      async (wf) => [
        await wf.agent({ title: "Same", prompt: "one" }),
        await wf.agent({ title: "Same", prompt: "two" }),
      ],
      { driver },
    )

    expect(report.result).toEqual(["one", "two"])
  })
})
