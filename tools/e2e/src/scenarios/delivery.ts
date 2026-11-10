import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, type Message, piDir, reply, sseHeaders, text, toolCall } from "../fake-model.ts"
import {
  binary,
  expect,
  expectAnswered,
  expectFacts,
  fail,
  herdr,
  readDb,
  row,
  rows,
  Skip,
  until,
  type World,
} from "../world.ts"
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
  row<{ n: number }>(w, "SELECT count(*) AS n FROM turn WHERE session_id = ?", sub)?.n ?? 0

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
        const merged = row<{ id: number; status: string }>(
          w,
          "SELECT id, status FROM turn WHERE session_id = ? ORDER BY id DESC",
          sub,
        )
        const sends = rows<{ turn: number | null }>(
          w,
          "SELECT turn_id AS turn FROM inbox WHERE recipient_session_id = ? AND kind = 'send'",
          sub,
        )
        expect(
          merged?.status === "completed" && sends.length === 2 && sends.every((s) => s.turn === merged.id),
          `the sends ${JSON.stringify(sends)} are not both on the merged turn ${JSON.stringify(merged)}`,
        )
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
        await expectAnswered(w, id, mainId)
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
        const turns = rows<{ status: string }>(w, "SELECT status FROM turn WHERE session_id = ? ORDER BY id", sub)
        expect(
          JSON.stringify(turns.map((t) => t.status)) === '["interrupted","completed"]',
          `the subagent's turns: ${JSON.stringify(turns)}`,
        )
        expectFacts(w, sub, ["turn.started", "turn.ended", "inbox.queued", "turn.started", "inbox.moved", "turn.ended"])
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
  {
    id: "S40",
    title:
      "a terminal opened by a server that inherited a finished subagent's environment is refused a user command with a hint naming the session and the env -u way out, which then works; the subagent itself is refused",
    run: async (w) => {
      needs()
      const envFile = path.join(w.root, "s40-agent-env.json")
      const asAgent = path.join(w.root, "s40-agent.txt")
      const hinted = path.join(w.root, "s40-hinted.txt")
      const asUser = path.join(w.root, "s40-user.txt")
      const main = recordingModel(() => reply("ok"))
      const sub = recordingModel((messages) =>
        messages.some((m) => m.role === "tool")
          ? reply("done-s40\nstatus: completed")
          : toolCall("call1", "bash", {
              command: `perl -MJSON::PP -e 'print encode_json(\\%ENV)' > ${envFile}; ${binary} daemon import-check > ${asAgent} 2>&1`,
            }),
      )
      let session = ""
      const stale = `${w.herdrSession}-stale`
      let server: ReturnType<typeof Bun.spawn> | undefined
      try {
        const m = await piMain(w, "stale-env", main.url)
        session = m.session
        const id = await runSub(w, m.repo, session, sub.url, "pi-stale-env-sub", "dump the environment")
        await until(
          "the subagent's result",
          async () => ((await resultOf(w, m.repo, id))?.message ?? "").includes("done-s40"),
          60_000,
        )
        const refused = await fs
          .readFile(asAgent, "utf8")
          .catch(() => fail(`the subagent's command did not run: ${JSON.stringify(sub.requests.at(-1)?.map(text))}`))
        expect(refused.includes("Forbidden"), `the subagent ran a user command: ${refused}`)
        await w.ok(["archive", id], { cwd: m.repo })
        const agentEnv = JSON.parse(await fs.readFile(envFile, "utf8")) as Record<string, string>
        expect(agentEnv.VIBEST_SESSION_ID === id, `captured VIBEST_SESSION_ID ${agentEnv.VIBEST_SESSION_ID}, not ${id}`)
        server = Bun.spawn(["herdr", "server", "--session", stale], {
          env: agentEnv,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        })
        const socket = path.join(w.home, ".config", "herdr", "sessions", stale, "herdr.sock")
        await until(
          "the inherited herdr server",
          () =>
            fs.stat(socket).then(
              () => true,
              () => false,
            ),
          20_000,
        ).catch(async (e: Error) => {
          server?.kill()
          fail(`${e.message}: ${await new Response(server?.stderr as ReadableStream).text()}`)
        })
        const workspace = await herdr(socket, "workspace.create", { cwd: m.repo, focus: false, label: "stale" })
        const created = await herdr(socket, "tab.create", {
          cwd: m.repo,
          focus: true,
          workspace_id: (workspace.workspace as { workspace_id: string }).workspace_id,
        })
        const pane = (created.root_pane as { pane_id: string }).pane_id
        await until(
          "the new terminal's shell",
          async () => {
            const info = await herdr(socket, "pane.process_info", { pane_id: pane })
            const fg =
              (info.process_info as { foreground_processes?: Array<{ name: string }> } | undefined)
                ?.foreground_processes ?? []
            return fg.length > 0 && fg.every((p) => /^-?(zsh|bash|sh|fish)$/.test(path.basename(p.name)))
          },
          30_000,
        )
        const typed = async (line: string, file: string) => {
          await herdr(socket, "pane.send_text", {
            pane_id: pane,
            text: `${line} > ${file} 2>&1; echo "exit=$? session=$VIBEST_SESSION_ID" >> ${file}`,
          })
          await herdr(socket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
          await until(
            `${line} in the new terminal`,
            async () => (await fs.readFile(file, "utf8").catch(() => "")).includes("exit="),
            60_000,
          )
          return fs.readFile(file, "utf8")
        }
        const refusedHere = await typed(`${binary} machine ls`, hinted)
        expect(refusedHere.includes(`session=${id}`), `the new terminal did not inherit the identity: ${refusedHere}`)
        const wayOut = "env -u VIBEST_SESSION_ID -u VIBEST_AGENT vibest machine ls"
        expect(
          refusedHere.includes("Forbidden") &&
            refusedHere.includes(`This shell carries agent session ${id}`) &&
            refusedHere.includes(wayOut) &&
            refusedHere.includes("open a terminal that was not started from an agent"),
          `no hint for the user: ${refusedHere}`,
        )
        const ran = await typed(wayOut.replace(/ vibest /, ` ${binary} `), asUser)
        expect(ran.includes("exit=0") && !ran.includes("Forbidden"), `the hinted command failed: ${ran}`)
      } finally {
        server?.kill()
        await server?.exited
        main.stop()
        sub.stop()
        await dropHerdrSession(w, stale)
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default checks
