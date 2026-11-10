import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, type Message, piDir, reply, sseHeaders, text, toolCall } from "../fake-model.ts"
import { expect, fail, readDb, row, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"

const needs = () => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
}

const piMain = async (w: World, name: string, url: string) => {
  const session = `${w.herdrSession}-${name}`
  const repo = await project(w, name)
  const dir = await piDir(w, `pi-${name}`, url)
  await w.daemon()
  await w.startMain({ harness: "pi", session, cwd: repo, env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 90_000 })
  return { session, repo }
}

const runSub = async (w: World, repo: string, session: string, url: string, name: string, task: string) =>
  (
    JSON.parse(
      await w.ok(
        ["run", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${await piDir(w, name, url)}`, "--", task],
        { cwd: repo, timeoutMs: 90_000 },
      ),
    ) as { id: string }
  ).id

const resultOf = async (w: World, repo: string, sub: string) =>
  (await w.json<{ result?: { message?: string; status?: string } | null }>(["result", sub], { cwd: repo })).result

const inboxRows = (w: World, sql: string, ...args: Array<string>) =>
  row<{ n: number }>(w, `SELECT count(*) AS n FROM inbox WHERE ${sql}`, ...args)?.n ?? 0

const readRows = (w: World, sql: string, ...args: Array<string>) => {
  const db = readDb(path.join(w.vibestHome, "vibest.db"))
  try {
    return db.query(sql).all(...args)
  } finally {
    db.close()
  }
}

const turnStarts = (w: World, sub: string) =>
  row<{ n: number }>(w, "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.start'", sub)?.n ?? 0

const recordingModel = (answer: (messages: Array<Message>) => string | Promise<string>) => {
  const requests: Array<Array<Message>> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      requests.push(messages)
      return new Response(await answer(messages), { headers: sseHeaders })
    },
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "S2",
    title:
      "two sends to a busy Pi subagent are queued, then delivered once it is idle, merged into one prompt: one more turn, both rows delivered",
    run: async (w) => {
      needs()
      const main = heldModel()
      main.release()
      const model = heldModel()
      let session = ""
      try {
        const m = await piMain(w, "merge", main.url)
        session = m.session
        const sub = await runSub(w, m.repo, session, model.url, "pi-merge-sub", ask("busy"))
        await until("the subagent's turn held", () => model.held() > 0, 60_000)
        for (const task of ["first", "second"]) await w.ok(["send", sub, "--", ask(task)], { cwd: m.repo })
        expect(
          inboxRows(w, "recipient_session_id = ? AND kind = 'send' AND status = 'pending'", sub) === 2,
          "the two sends are not both pending while the subagent is busy",
        )
        model.release()
        await until(
          "both sends delivered",
          () => inboxRows(w, "recipient_session_id = ? AND kind = 'send' AND status = 'delivered'", sub) === 2,
          60_000,
        )
        await until(
          "the merged turn's result",
          async () => ((await resultOf(w, m.repo, sub))?.message ?? "").includes("done-first"),
          60_000,
        )
        expect(turnStarts(w, sub) === 2, `${turnStarts(w, sub)} turns, not the first and one merged turn`)
        expect(
          model.asked("first") === 1 && model.asked("second") === 0,
          `the model was asked "first" ${model.asked("first")} and "second" ${model.asked("second")} times on its own`,
        )
      } finally {
        main.stop()
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S3",
    title:
      "a Pi subagent's two vibest reports reach the Pi main agent: two report rows to the main agent, both delivered, each seen once by its model, both before the subagent's result",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      const sub = recordingModel((messages) =>
        messages.some((m) => m.role === "tool")
          ? reply("done-s3\nstatus: completed")
          : toolCall("call1", "bash", { command: "vibest report -- report-one && vibest report -- report-two" }),
      )
      let session = ""
      try {
        const m = await piMain(w, "report", main.url)
        session = m.session
        const mainId = row<{ id: string }>(w, "SELECT id FROM session WHERE role = 'main' AND ended_at IS NULL")!.id
        const id = await runSub(w, m.repo, session, sub.url, "pi-report-sub", "report twice")
        const reports = () =>
          readRows(
            w,
            "SELECT recipient_session_id AS r, content, status FROM inbox WHERE sender_session_id = ? AND kind = 'report'",
            id,
          ) as Array<{ r: string; content: string; status: string }>
        await until(
          "both reports delivered",
          () => reports().filter((r) => r.status === "delivered").length === 2,
          60_000,
        ).catch((e: Error) => fail(`${e.message}: ${JSON.stringify(reports())}`))
        expect(
          reports().every((r) => r.r === mainId),
          `reports not addressed to the main agent ${mainId}: ${JSON.stringify(reports())}`,
        )
        await until(
          "the subagent's result",
          async () => ((await resultOf(w, m.repo, id))?.message ?? "").includes("done-s3"),
          60_000,
        )
        const conversation = () =>
          (main.requests.findLast((r) => r.some((message) => text(message).includes("done-s3"))) ?? []).map(text)
        await until("the main agent's model saw the result", () => conversation().length > 0, 60_000)
        const seen = conversation().join("\n")
        for (const r of ["report-one", "report-two"]) {
          const holding = conversation().filter((t) => t.includes(r)).length
          expect(holding === 1, `the main agent's model saw ${r} in ${holding} messages, not once: ${seen}`)
          expect(seen.indexOf(r) < seen.indexOf("done-s3"), `${r} reached the main agent after the result: ${seen}`)
        }
      } finally {
        main.stop()
        sub.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S4",
    title:
      "after vibest interrupt stops a Pi subagent's held turn, the next vibest send starts a turn whose result arrives",
    run: async (w) => {
      needs()
      const main = heldModel()
      main.release()
      const model = heldModel()
      let session = ""
      try {
        const m = await piMain(w, "next", main.url)
        session = m.session
        const sub = await runSub(w, m.repo, session, model.url, "pi-next-sub", ask("stuck"))
        await until("the subagent's turn held", () => model.held() > 0, 60_000)
        const stop = await w.vibest(["interrupt", sub], { cwd: m.repo, timeoutMs: 60_000 })
        expect(stop.code === 0 && stop.stdout.includes("interrupted"), `interrupt: ${stop.stderr}${stop.stdout}`)
        model.release()
        await w.ok(["send", sub, "--", ask("next")], { cwd: m.repo })
        await until(
          "the next turn's result",
          async () => {
            const r = await resultOf(w, m.repo, sub)
            return (r?.message ?? "").includes("done-next")
          },
          60_000,
        )
        expect(
          inboxRows(w, "recipient_session_id = ? AND kind = 'send' AND status = 'delivered'", sub) === 1,
          "the send after the interrupt is not delivered",
        )
        const results = readRows(w, "SELECT content FROM inbox WHERE sender_session_id = ? AND kind = 'result'", sub)
        expect(
          results.length === 1 && JSON.stringify(results).includes("done-next"),
          `results other than the next turn's: ${JSON.stringify(results)}`,
        )
      } finally {
        main.stop()
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S8",
    title:
      "vibest run pi --model with a model Pi does not list is refused (HarnessUnavailable) naming the model, and starts no session",
    run: async (w) => {
      needs()
      const main = heldModel()
      main.release()
      let session = ""
      try {
        const m = await piMain(w, "badmodel", main.url)
        session = m.session
        const before = row<{ n: number }>(w, "SELECT count(*) AS n FROM session")?.n ?? 0
        const r = await w.vibest(
          [
            "run",
            "pi",
            "--session",
            session,
            "--model",
            "no-such-model-e2e",
            "--env",
            `PI_CODING_AGENT_DIR=${await piDir(w, "pi-badmodel-sub", main.url)}`,
            "--",
            ask("bad"),
          ],
          { cwd: m.repo, timeoutMs: 60_000 },
        )
        expect(
          r.code !== 0 && r.stderr.includes("HarnessUnavailable") && r.stderr.includes("no-such-model-e2e"),
          `vibest run exited ${r.code}: ${r.stderr}${r.stdout}`,
        )
        const after = row<{ n: number }>(w, "SELECT count(*) AS n FROM session")?.n ?? 0
        expect(after === before, `${after - before} sessions were created`)
      } finally {
        main.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default checks
