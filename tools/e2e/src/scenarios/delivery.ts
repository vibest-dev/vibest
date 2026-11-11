import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, type Message, piDir, reply, sseHeaders, text, toolCall } from "../fake-model.ts"
import {
  binary,
  expect,
  answerOf,
  expectAnswered,
  expectFacts,
  fail,
  herdr,
  row,
  rows,
  SESSIONS,
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

const inboxRows = (w: World, sql: string, ...args: Array<string>) =>
  row<{ n: number }>(w, `SELECT count(*) AS n FROM inbox WHERE ${sql}`, ...args)?.n ?? 0

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

const lastTurn = (w: World, sub: string) =>
  row<{ status: string; failure: string | null }>(
    w,
    "SELECT status, failure FROM turn WHERE session_id = ? AND status IS NOT NULL ORDER BY id DESC LIMIT 1",
    sub,
  )

const mainOf = (w: World) =>
  row<{ id: string }>(w, "SELECT id FROM session WHERE role = 'main' AND ended_at IS NULL")!.id

const sendsFrom = (w: World, sender: string, recipient: string) =>
  rows<{ id: number; status: string; turn: number | null; content: string }>(
    w,
    "SELECT id, status, turn_id AS turn, content FROM inbox WHERE sender_session_id = ? AND recipient_session_id = ? AND kind = 'send'",
    sender,
    recipient,
  )

const countFacts = (w: World, sql: string, ...args: Array<string | number>) =>
  row<{ n: number }>(w, `SELECT count(*) AS n FROM event WHERE ${sql}`, ...args)?.n ?? 0

const sendingModel = (to: () => string, message: string) =>
  recordingModel((messages) =>
    messages.some((m) => m.role === "tool")
      ? reply("done-send\nstatus: completed")
      : toolCall("call1", "bash", { command: `${binary} send ${to()} -- ${message}` }),
  )

const seen = (model: ReturnType<typeof recordingModel>) => model.requests.flat().map(text).join("\n")

const turnErrorChecks: ReadonlyArray<Check> = [
  {
    id: "S50",
    title:
      "a turn that ends in an error fails with its failure and sends the creator one notice carrying it, typed into the main agent once",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      const broken = recordingModel(() => `data: ${JSON.stringify({ error: { message: "model exploded" } })}\n\n`)
      let session = ""
      try {
        const m = await piMain(w, "turn-error", main.url)
        session = m.session
        const id = await runSub(w, m.repo, session, broken.url, "pi-turn-error-sub", "fail")
        const notices = () =>
          rows<{ status: string; recipient: string | null; content: string }>(
            w,
            "SELECT status, recipient_session_id AS recipient, content FROM inbox WHERE sender_session_id = ? AND kind = 'notice'",
            id,
          )
        await until("the turn failed", () => lastTurn(w, id)?.status === "failed", 120_000)
        await until(
          "the notice typed into the main agent",
          () => notices().some((n) => n.status === "delivered"),
          60_000,
        )
        const failed = lastTurn(w, id)!
        expect(failed.failure?.includes("model exploded") === true, `the turn's failure: ${JSON.stringify(failed)}`)
        expect(
          notices().length === 1 &&
            notices()[0]!.recipient === mainOf(w) &&
            notices()[0]!.content.includes("model exploded"),
          `notices from ${id}: ${JSON.stringify(notices())}`,
        )
        await until("the main agent's model saw it", () => seen(main).includes("model exploded"), 60_000)
      } finally {
        main.stop()
        broken.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

const sendChecks: ReadonlyArray<Check> = [
  {
    id: "S45",
    title:
      "a Pi subagent's vibest send to the Pi main agent is one send row from the subagent to the main agent, delivered, with one inbox.queued and one inbox.moved to delivered, and the main agent's model request holds <agent-message> with the subagent's id",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      let mainId = ""
      const sub = sendingModel(() => mainId, "hello-main")
      let session = ""
      try {
        const m = await piMain(w, "send-main", main.url)
        session = m.session
        mainId = mainOf(w)
        const id = await runSub(w, m.repo, session, sub.url, "pi-send-main-sub", "send to the main agent")
        await until("the send delivered", () => sendsFrom(w, id, mainId).some((r) => r.status === "delivered"), 60_000)
        const sent = sendsFrom(w, id, mainId)
        expect(sent.length === 1, `${sent.length} sends from ${id} to the main agent: ${JSON.stringify(sent)}`)
        expect(
          countFacts(w, "type = 'inbox.queued' AND seq = ?", sent[0]!.id) === 1 &&
            countFacts(
              w,
              "type = 'inbox.moved' AND json_extract(data, '$.inbox') = ? AND json_extract(data, '$.to') = 'delivered'",
              sent[0]!.id,
            ) === 1,
          `the send ${sent[0]!.id} has not exactly one inbox.queued and one inbox.moved to delivered`,
        )
        await until("the main agent's model saw the send", () => seen(main).includes("hello-main"), 60_000)
        expect(
          seen(main).includes("<agent-message>") && seen(main).includes(id),
          `the main agent's model saw ${seen(main)}`,
        )
      } finally {
        main.stop()
        sub.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S46",
    title: "a Pi subagent's vibest send to a sibling is refused, and no inbox.queued row is written",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      const sibling = recordingModel(() => reply("done-sibling\nstatus: completed"))
      let siblingId = ""
      const refused = path.join(w.root, "s46-refused.txt")
      const sender = recordingModel((messages) =>
        messages.some((m) => m.role === "tool")
          ? reply("done-send\nstatus: completed")
          : toolCall("call1", "bash", {
              command: `${binary} send ${siblingId} -- hello-sibling > ${refused} 2>&1`,
            }),
      )
      let session = ""
      try {
        const m = await piMain(w, "send-sibling", main.url)
        session = m.session
        siblingId = await runSub(w, m.repo, session, sibling.url, "pi-send-sibling-b", "wait")
        await until(
          "the sibling answered",
          async () => (await answerOf(w, siblingId, m.repo)).includes("done-sibling"),
          90_000,
        )
        const id = await runSub(w, m.repo, session, sender.url, "pi-send-sibling-a", "send to the sibling")
        await until("the sender answered", async () => (await answerOf(w, id, m.repo)).includes("done-send"), 90_000)
        const out = await fs.readFile(refused, "utf8")
        expect(out.includes(siblingId) && out.includes("did not start"), `vibest send printed: ${out}`)
        expect(
          sendsFrom(w, id, siblingId).length === 0,
          `a send row was written: ${JSON.stringify(sendsFrom(w, id, siblingId))}`,
        )
        expect(
          countFacts(
            w,
            "type = 'inbox.queued' AND json_extract(data, '$.sender') = ? AND json_extract(data, '$.recipient') = ?",
            id,
            siblingId,
          ) === 0,
          "inbox.queued was written for the refused send",
        )
      } finally {
        main.stop()
        sibling.stop()
        sender.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S47",
    title:
      "a Pi subagent's vibest send to a session of another project is Forbidden, and to an archived session NoSuchSession naming the project's main agent; neither appends an inbox.queued",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      const other = recordingModel(() => reply("ok"))
      const idle = recordingModel(() => reply("done-idle\nstatus: completed"))
      let foreign = ""
      let archived = ""
      const refused = path.join(w.root, "s47-refused.txt")
      const sender = recordingModel((messages) =>
        messages.some((m) => m.role === "tool")
          ? reply("done-s47\nstatus: completed")
          : toolCall("call1", "bash", {
              command: `${binary} send ${foreign} -- one > ${refused} 2>&1; ${binary} send ${archived} -- two >> ${refused} 2>&1`,
            }),
      )
      const sessions: Array<string> = []
      try {
        const m = await piMain(w, "send-refused", main.url)
        sessions.push(m.session)
        const o = await piMain(w, "send-refused-other", other.url)
        sessions.push(o.session)
        foreign = await runSub(w, o.repo, o.session, other.url, "pi-send-refused-other-sub", "idle in another project")
        archived = await runSub(w, m.repo, m.session, idle.url, "pi-send-refused-archived", "finish and be archived")
        await until("the archived session's turn", () => turnStarts(w, archived) === 1, 60_000)
        await w.ok(["archive", archived], { cwd: m.repo })
        const id = await runSub(w, m.repo, m.session, sender.url, "pi-send-refused-sender", "send twice")
        await until(
          "both refusals written",
          async () => (await fs.readFile(refused, "utf8").catch(() => "")).includes("NoSuchSession"),
          60_000,
        )
        const written = await fs.readFile(refused, "utf8")
        expect(
          written.includes("Forbidden") && written.includes("belongs to another coordinator"),
          `no Forbidden for the other project's session: ${written}`,
        )
        expect(written.includes(mainOf(w)), `the archived refusal does not name the main agent: ${written}`)
        expect(
          countFacts(
            w,
            "type = 'inbox.queued' AND json_extract(data, '$.kind') = 'send' AND json_extract(data, '$.sender') = ?",
            id,
          ) === 0,
          `an inbox.queued names ${id} as sender`,
        )
      } finally {
        main.stop()
        other.stop()
        idle.stop()
        sender.stop()
        for (const session of sessions) await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S48",
    title:
      "when the main agent's pane is killed before a subagent's vibest send reaches it, the row ends failed and one notice row goes to the sender (recipient_session_id = the sender), which is typed into the sender and seen by its model",
    run: async (w) => {
      needs()
      const main = heldModel()
      let mainId = ""
      const sender = sendingModel(() => mainId, "never-delivered")
      let session = ""
      try {
        const m = await piMain(w, "send-killed", main.url)
        session = m.session
        mainId = mainOf(w)
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        await until("the main agent's turn held", () => main.held() > 0, 60_000)
        const id = await runSub(w, m.repo, session, sender.url, "pi-send-killed-a", "send to the main agent")
        await until("the send pending", () => sendsFrom(w, id, mainId).some((r) => r.status === "pending"), 60_000)
        const runtime = row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, mainId)!.r
        const pane = ((JSON.parse(runtime) as { id?: string }).id ?? "").split("/")[1] ?? ""
        await herdr(socket, "pane.close", { pane_id: pane })
        await until("the send failed", () => sendsFrom(w, id, mainId).some((r) => r.status === "failed"), 60_000)
        const notices = () =>
          rows<{ status: string; sender: string | null }>(
            w,
            "SELECT status, sender_session_id AS sender FROM inbox WHERE recipient_session_id = ? AND kind = 'notice' AND instr(content, 'was not delivered') > 0",
            id,
          )
        await until(
          "one notice to the sender, typed into it",
          () => notices().some((n) => n.status === "delivered"),
          60_000,
        )
        expect(notices().length === 1, `${notices().length} notices to the sender: ${JSON.stringify(notices())}`)
        await until("the sender's model saw the notice", () => seen(sender).includes("was not delivered"), 60_000)
      } finally {
        main.release()
        main.stop()
        sender.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

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
          "the merged turn's answer",
          async () => (await answerOf(w, sub, m.repo)).includes("done-first"),
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
      "a turn end sends nothing: a Pi subagent ends its turn without sending; the turn completes with its answer, no inbox row has the subagent as sender, no inbox.queued names it as sender, and the main agent's model gets no request after the subagent went idle",
    run: async (w) => {
      needs()
      const main = recordingModel(() => reply("ok"))
      const sub = recordingModel(() => reply("done-s3\nstatus: completed"))
      let session = ""
      try {
        const m = await piMain(w, "quiet", main.url)
        session = m.session
        const id = await runSub(w, m.repo, session, sub.url, "pi-quiet-sub", "end the turn without sending")
        await until("the subagent's answer", async () => (await answerOf(w, id, m.repo)).includes("done-s3"), 60_000)
        await expectAnswered(w, id)
        const asked = main.requests.length
        await Bun.sleep(5_000)
        expect(
          main.requests.length === asked,
          `the main agent's model got ${main.requests.length - asked} more requests`,
        )
        expect(inboxRows(w, "sender_session_id = ?", id) === 0, `rows sent by ${id}`)
        expect(
          countFacts(w, "type = 'inbox.queued' AND json_extract(data, '$.sender') = ?", id) === 0,
          `an inbox.queued names ${id} as sender`,
        )
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
      "after vibest interrupt stops a Pi subagent's held turn, which sends and notifies nothing, the next vibest send starts a turn whose answer arrives",
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
          "the next turn's answer",
          async () => (await answerOf(w, sub, m.repo)).includes("done-next"),
          60_000,
        )
        expect(
          inboxRows(w, "recipient_session_id = ? AND kind = 'send' AND status = 'delivered'", sub) === 1,
          "the send after the interrupt is not delivered",
        )
        expect(inboxRows(w, "sender_session_id = ?", sub) === 0, "the subagent sent or notified something")
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
        await until("the subagent's answer", async () => (await answerOf(w, id, m.repo)).includes("done-s40"), 60_000)
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

export default [...checks, ...sendChecks, ...turnErrorChecks]
