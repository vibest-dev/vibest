import fs from "node:fs/promises"
import path from "node:path"

import { note } from "../../../reap.ts"
import type { Check } from "../check.ts"
import {
  ask,
  entryRun,
  heldModel,
  isEntryRunResult,
  type Message,
  piDir,
  reply,
  sseHeaders,
  text,
  toolCall,
} from "../fake-model.ts"
import {
  binary,
  expect,
  replyOf,
  expectReplied,
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

const piEntry = async (w: World, name: string, url: string) => {
  const session = `${w.herdrSession}-${name}`
  const repo = await project(w, name)
  const dir = await piDir(w, `pi-${name}`, url)
  await w.daemon()
  await w.startEntry({ harness: "pi", session, cwd: repo, env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 90_000 })
  return { session, repo }
}

const runSub = async (w: World, repo: string, session: string, url: string, name: string, task: string) =>
  (
    JSON.parse(
      await w.okViaEntry(
        ["run", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${await piDir(w, name, url)}`, "--", task],
        { cwd: repo, timeoutMs: 90_000 },
      ),
    ) as { id: string }
  ).id

const inboxRows = (w: World, sql: string, ...args: Array<string>) =>
  row<{ n: number }>(w, `SELECT count(*) AS n FROM inbox WHERE ${sql}`, ...args)?.n ?? 0

const executionStarts = (w: World, sub: string) =>
  row<{ n: number }>(w, "SELECT count(*) AS n FROM execution WHERE session_id = ?", sub)?.n ?? 0

const recordingModel = (answer: (messages: Array<Message>) => string | Promise<string>) => {
  const requests: Array<Array<Message>> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const entryAnswer = entryRun(messages)
      if (entryAnswer !== undefined) return new Response(entryAnswer, { headers: sseHeaders })
      requests.push(messages)
      return new Response(await answer(messages), { headers: sseHeaders })
    },
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const lastExecution = (w: World, sub: string) =>
  row<{ status: string; failure: string | null }>(
    w,
    "SELECT outcome AS status, failure FROM execution WHERE session_id = ? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1",
    sub,
  )

const entryIdOf = (w: World) =>
  row<{ id: string }>(w, "SELECT id FROM session WHERE agent = 'coordinator' AND ended_at IS NULL")!.id

const sendsFrom = (w: World, sender: string, recipient: string) =>
  rows<{ id: number; status: string; execution: number | null; content: string }>(
    w,
    "SELECT id, status, execution_id AS execution, content FROM inbox WHERE sender_session_id = ? AND session_id = ? AND kind = 'send'",
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

const executionErrorChecks: ReadonlyArray<Check> = [
  {
    id: "S50",
    title:
      "an execution that ends in an error fails with its failure and sends the creator one notice carrying it, typed into the entry session once",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      const broken = recordingModel(() => `data: ${JSON.stringify({ error: { message: "model exploded" } })}\n\n`)
      let session = ""
      try {
        const m = await piEntry(w, "execution-error", entryModel.url)
        session = m.session
        const id = await runSub(w, m.repo, session, broken.url, "pi-execution-error-sub", "fail")
        const notices = () =>
          rows<{ status: string; recipient: string | null; content: string }>(
            w,
            "SELECT status, session_id AS recipient, content FROM inbox WHERE sender_session_id = ? AND kind = 'notice'",
            id,
          )
        await until("the execution failed", () => lastExecution(w, id)?.status === "failed", 120_000)
        await until(
          "the notice typed into the entry session",
          () => notices().some((n) => n.status === "delivered"),
          60_000,
        )
        const failed = lastExecution(w, id)!
        expect(
          failed.failure?.includes("model exploded") === true,
          `the execution's failure: ${JSON.stringify(failed)}`,
        )
        expect(
          notices().length === 1 &&
            notices()[0]!.recipient === entryIdOf(w) &&
            notices()[0]!.content.includes("model exploded"),
          `notices from ${id}: ${JSON.stringify(notices())}`,
        )
        await until("the entry session's model saw it", () => seen(entryModel).includes("model exploded"), 60_000)
      } finally {
        entryModel.stop()
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
      "a Pi subagent's vibest send to the Pi entry session is one send row from the subagent to the entry session, delivered, with one inbox.queued and one inbox.moved to delivered, and the entry session's model request holds <agent-message> with the subagent's id",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      let entryId = ""
      const sub = sendingModel(() => entryId, "hello-main")
      let session = ""
      try {
        const m = await piEntry(w, "send-main", entryModel.url)
        session = m.session
        entryId = entryIdOf(w)
        const id = await runSub(w, m.repo, session, sub.url, "pi-send-main-sub", "send to the entry session")
        await until("the send delivered", () => sendsFrom(w, id, entryId).some((r) => r.status === "delivered"), 60_000)
        const sent = sendsFrom(w, id, entryId)
        expect(sent.length === 1, `${sent.length} sends from ${id} to the entry session: ${JSON.stringify(sent)}`)
        expect(
          countFacts(w, "aggregate = ? AND type = 'inbox.queued' AND seq = ?", entryId, sent[0]!.id) === 1 &&
            countFacts(
              w,
              "aggregate = ? AND type = 'inbox.moved' AND json_extract(data, '$.inbox') = ? AND json_extract(data, '$.to') = 'delivered'",
              entryId,
              sent[0]!.id,
            ) === 1,
          `the send ${sent[0]!.id} has not exactly one inbox.queued and one inbox.moved to delivered`,
        )
        await until("the entry session's model saw the send", () => seen(entryModel).includes("hello-main"), 60_000)
        expect(
          seen(entryModel).includes("<agent-message>") && seen(entryModel).includes(id),
          `the entry session's model saw ${seen(entryModel)}`,
        )
      } finally {
        entryModel.stop()
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
      const entryModel = recordingModel(() => reply("ok"))
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
        const m = await piEntry(w, "send-sibling", entryModel.url)
        session = m.session
        siblingId = await runSub(w, m.repo, session, sibling.url, "pi-send-sibling-b", "wait")
        await until(
          "the sibling answered",
          async () => (await replyOf(w, siblingId, m.repo)).includes("done-sibling"),
          90_000,
        )
        const id = await runSub(w, m.repo, session, sender.url, "pi-send-sibling-a", "send to the sibling")
        await until("the sender answered", async () => (await replyOf(w, id, m.repo)).includes("done-send"), 90_000)
        const out = await fs.readFile(refused, "utf8")
        expect(
          out.includes(siblingId) && out.includes("did not start") && out.includes(entryIdOf(w)),
          `vibest send printed: ${out}`,
        )
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
        entryModel.stop()
        sibling.stop()
        sender.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S47",
    title:
      "a Pi subagent's vibest send to a session of another project is Forbidden, and to an archived session NoSuchSession naming the project's entry session; neither appends an inbox.queued",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
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
        const m = await piEntry(w, "send-refused", entryModel.url)
        sessions.push(m.session)
        const o = await piEntry(w, "send-refused-other", other.url)
        sessions.push(o.session)
        foreign = await runSub(w, o.repo, o.session, other.url, "pi-send-refused-other-sub", "idle in another project")
        archived = await runSub(w, m.repo, m.session, idle.url, "pi-send-refused-archived", "finish and be archived")
        await until("the archived session's execution", () => executionStarts(w, archived) === 1, 60_000)
        await w.ok(["archive", archived], { cwd: m.repo })
        const id = await runSub(w, m.repo, m.session, sender.url, "pi-send-refused-sender", "send twice")
        await until(
          "both refusals written",
          async () => (await fs.readFile(refused, "utf8").catch(() => "")).includes("NoSuchSession"),
          60_000,
        )
        const written = await fs.readFile(refused, "utf8")
        expect(
          written.includes("Forbidden") && written.includes("belongs to another entry session"),
          `no Forbidden for the other project's session: ${written}`,
        )
        expect(written.includes(entryIdOf(w)), `the archived refusal does not name the entry session: ${written}`)
        expect(
          countFacts(
            w,
            "type = 'inbox.queued' AND json_extract(data, '$.kind') = 'send' AND json_extract(data, '$.sender') = ?",
            id,
          ) === 0,
          `an inbox.queued names ${id} as sender`,
        )
      } finally {
        entryModel.stop()
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
      "when a subagent's pane is killed before the entry session's vibest send reaches it, the row ends failed and one notice row goes to the sender (session_id = the sender), which is typed into the sender and seen by its model",
    run: async (w) => {
      needs()
      let target = ""
      const entryModel = recordingModel((messages) => {
        if (messages.some((m) => m.role === "tool" && !isEntryRunResult(m)))
          return reply("done-main\nstatus: completed")
        return text(messages.at(-1)).includes("send-now")
          ? toolCall("call1", "bash", { command: `${binary} send ${target} -- never-delivered` })
          : reply("ok")
      })
      const held = heldModel()
      let session = ""
      try {
        const m = await piEntry(w, "send-killed", entryModel.url)
        session = m.session
        const entryId = entryIdOf(w)
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        target = await runSub(w, m.repo, session, held.url, "pi-send-killed-b", ask("held"))
        await until("the subagent's execution held", () => held.held() > 0, 60_000)
        await w.ok(["send", entryId, "--", "send-now"], { cwd: m.repo })
        await until("the send pending", () => sendsFrom(w, entryId, target).some((r) => r.status === "pending"), 60_000)
        const runtime = row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, target)!.r
        const pane = ((JSON.parse(runtime) as { id?: string }).id ?? "").split("/")[1] ?? ""
        await herdr(socket, "pane.close", { pane_id: pane })
        await until("the send failed", () => sendsFrom(w, entryId, target).some((r) => r.status === "failed"), 60_000)
        const notices = () =>
          rows<{ status: string; sender: string | null }>(
            w,
            "SELECT status, sender_session_id AS sender FROM inbox WHERE session_id = ? AND kind = 'notice' AND instr(content, 'was not delivered') > 0",
            entryId,
          )
        await until(
          "one notice to the sender, typed into it",
          () => notices().some((n) => n.status === "delivered"),
          60_000,
        )
        expect(notices().length === 1, `${notices().length} notices to the sender: ${JSON.stringify(notices())}`)
        await until("the sender's model saw the notice", () => seen(entryModel).includes("was not delivered"), 60_000)
      } finally {
        entryModel.stop()
        held.release()
        held.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

const checks: ReadonlyArray<Check> = [
  {
    id: "S2",
    covers: ["S54"],
    title:
      "two sends to a busy Pi subagent are queued, then delivered once it is idle, merged into one prompt: one more execution, both rows delivered",
    run: async (w) => {
      needs()
      const entryModel = heldModel()
      entryModel.release()
      const model = heldModel()
      let session = ""
      try {
        const m = await piEntry(w, "merge", entryModel.url)
        session = m.session
        const sub = await runSub(w, m.repo, session, model.url, "pi-merge-sub", ask("busy"))
        await until("the subagent's execution held", () => model.held() > 0, 60_000)
        for (const task of ["first", "second"]) await w.ok(["send", sub, "--", ask(task)], { cwd: m.repo })
        expect(
          inboxRows(w, "session_id = ? AND kind = 'send' AND status = 'pending'", sub) === 2,
          "the two sends are not both pending while the subagent is busy",
        )
        model.release()
        await until(
          "both sends delivered",
          () => inboxRows(w, "session_id = ? AND kind = 'send' AND status = 'delivered'", sub) === 2,
          60_000,
        )
        await until(
          "the merged execution's reply",
          async () => (await replyOf(w, sub, m.repo)).includes("done-first"),
          60_000,
        )
        expect(
          executionStarts(w, sub) === 2,
          `${executionStarts(w, sub)} executions, not the first and one merged execution`,
        )
        const merged = row<{ id: number; status: string }>(
          w,
          "SELECT id, outcome AS status FROM execution WHERE session_id = ? ORDER BY id DESC",
          sub,
        )
        const sends = rows<{ execution: number | null }>(
          w,
          "SELECT execution_id AS execution FROM inbox WHERE session_id = ? AND kind = 'send'",
          sub,
        )
        expect(
          merged?.status === "completed" && sends.length === 2 && sends.every((s) => s.execution === merged.id),
          `the sends ${JSON.stringify(sends)} are not both on the merged execution ${JSON.stringify(merged)}`,
        )
        expect(
          model.asked("first") === 1 && model.asked("second") === 0,
          `the model was asked "first" ${model.asked("first")} and "second" ${model.asked("second")} times on its own`,
        )
      } finally {
        entryModel.stop()
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S3",
    title:
      "an execution end sends nothing: a Pi subagent ends its execution without sending; the execution completes with its reply, no inbox row has the subagent as sender, no inbox.queued names it as sender, and the entry session's model gets no request after the subagent went idle",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      const sub = recordingModel(() => reply("done-s3\nstatus: completed"))
      let session = ""
      try {
        const m = await piEntry(w, "quiet", entryModel.url)
        session = m.session
        const id = await runSub(w, m.repo, session, sub.url, "pi-quiet-sub", "end the execution without sending")
        await until("the subagent's answer", async () => (await replyOf(w, id, m.repo)).includes("done-s3"), 60_000)
        await expectReplied(w, id)
        const asked = entryModel.requests.length
        await Bun.sleep(5_000)
        expect(
          entryModel.requests.length === asked,
          `the entry session's model got ${entryModel.requests.length - asked} more requests`,
        )
        expect(inboxRows(w, "sender_session_id = ?", id) === 0, `rows sent by ${id}`)
        expect(
          countFacts(w, "type = 'inbox.queued' AND json_extract(data, '$.sender') = ?", id) === 0,
          `an inbox.queued names ${id} as sender`,
        )
      } finally {
        entryModel.stop()
        sub.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S4",
    title:
      "after vibest interrupt stops a Pi subagent's held execution, which sends and notifies nothing, the next vibest send starts an execution whose answer arrives",
    run: async (w) => {
      needs()
      const entryModel = heldModel()
      entryModel.release()
      const model = heldModel()
      let session = ""
      try {
        const m = await piEntry(w, "next", entryModel.url)
        session = m.session
        const sub = await runSub(w, m.repo, session, model.url, "pi-next-sub", ask("stuck"))
        await until("the subagent's execution held", () => model.held() > 0, 60_000)
        const stop = await w.vibest(["interrupt", sub], { cwd: m.repo, timeoutMs: 60_000 })
        expect(stop.code === 0 && stop.stdout.includes("interrupted"), `interrupt: ${stop.stderr}${stop.stdout}`)
        model.release()
        await w.ok(["send", sub, "--", ask("next")], { cwd: m.repo })
        await until(
          "the next execution's reply",
          async () => (await replyOf(w, sub, m.repo)).includes("done-next"),
          60_000,
        )
        await until(
          "the send after the interrupt delivered",
          () => inboxRows(w, "session_id = ? AND kind = 'send' AND status = 'delivered'", sub) === 1,
          10_000,
        )
        expect(inboxRows(w, "sender_session_id = ?", sub) === 0, "the subagent sent or notified something")
        const executions = rows<{ status: string }>(
          w,
          "SELECT outcome AS status FROM execution WHERE session_id = ? ORDER BY id",
          sub,
        )
        expect(
          JSON.stringify(executions.map((t) => t.status)) === '["interrupted","completed"]',
          `the subagent's executions: ${JSON.stringify(executions)}`,
        )
        expectFacts(w, sub, [
          "execution.started",
          "execution.ended",
          "inbox.queued",
          "execution.started",
          "inbox.moved",
          "execution.ended",
        ])
      } finally {
        entryModel.stop()
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
      const entryModel = heldModel()
      entryModel.release()
      let session = ""
      try {
        const m = await piEntry(w, "badmodel", entryModel.url)
        session = m.session
        const before = row<{ n: number }>(w, "SELECT count(*) AS n FROM session")?.n ?? 0
        const r = await w.viaEntry(
          [
            "run",
            "pi",
            "--session",
            session,
            "--model",
            "no-such-model-e2e",
            "--env",
            `PI_CODING_AGENT_DIR=${await piDir(w, "pi-badmodel-sub", entryModel.url)}`,
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
        entryModel.stop()
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
      const entryModel = recordingModel(() => reply("ok"))
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
        const m = await piEntry(w, "stale-env", entryModel.url)
        session = m.session
        const id = await runSub(w, m.repo, session, sub.url, "pi-stale-env-sub", "dump the environment")
        await until("the subagent's answer", async () => (await replyOf(w, id, m.repo)).includes("done-s40"), 60_000)
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
        note(server.pid, `herdr server --session ${stale}`, w.root)
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
        const wayOut = "env -u VIBEST_SESSION_ID vibest machine ls"
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
        if (server !== undefined && server.exitCode === null) {
          server.kill()
          for (const deadline = Date.now() + 2_000; server.exitCode === null && Date.now() < deadline;)
            await Bun.sleep(50)
          if (server.exitCode === null) server.kill("SIGKILL")
        }
        await server?.exited
        entryModel.stop()
        sub.stop()
        await dropHerdrSession(w, stale)
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default [...checks, ...sendChecks, ...executionErrorChecks]
