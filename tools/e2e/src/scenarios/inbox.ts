import fs from "node:fs/promises"
import path from "node:path"

import { PROTOCOL } from "../../../../packages/protocol/src/protocol.ts"
import type { Check } from "../check.ts"
import { answerFolderTrust, typeAndEnter } from "../drivers/claude.ts"
import {
  ask,
  claudeConfigOf,
  claudeEnv,
  claudeSendOrReply,
  taskIn,
  envArgs,
  delegatingModel,
  fakeAnthropic,
  heldModel,
  lastUser,
  piDir,
  reply,
  sseHeaders,
  toolCall,
  type Step,
  text,
} from "../fake-model.ts"
import {
  agentName,
  alive,
  replyOf,
  expect,
  expectReplied,
  fail,
  herdr,
  row,
  rows,
  SESSIONS,
  Skip,
  binary,
  transcript,
  until,
  type World,
  writeEvidence,
} from "../world.ts"

type Entry = { id: string; agent: string }

const HERDR_AGENT_START_TIMEOUT_MS = 120_000

export const project = async (w: World, name: string) => {
  const repo = path.join(w.root, name)
  await fs.mkdir(repo, { recursive: true })
  for (const argv of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    const r = await w.run(repo, argv)
    expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
  }
  return fs.realpath(repo)
}

export const dropHerdrSession = async (w: World, session: string) => {
  if (
    await fs.stat(path.join(w.home, ".config", "herdr", "sessions", session)).then(
      () => true,
      () => false,
    )
  ) {
    await w.run(w.root, ["herdr", "session", "stop", session])
    await w.run(w.root, ["herdr", "session", "delete", session])
  }
}

const claudeEntry = async (
  w: World,
  name: string,
  model: ReturnType<typeof delegatingModel>,
  respond: Parameters<typeof fakeAnthropic>[0] = () => "ok",
) => {
  const anthropic = fakeAnthropic(respond)
  const configTheResumeCheckReads = w.config.claude
  const flags = await claudeEnv(w, name, anthropic.url, configTheResumeCheckReads)
  const config = claudeConfigOf(flags)
  const settingsFile = path.join(config, "settings.json")
  const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as { permissions?: { allow?: Array<string> } }
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      ...settings,
      permissions: {
        ...settings.permissions,
        allow: [...(settings.permissions?.allow ?? []), `Bash(${binary} run:*)`],
      },
    }),
  )
  const session = `${w.herdrSession}-${name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const repo = await project(w, name)
  const env = `PI_CODING_AGENT_DIR=${await piDir(w, `pi-${name}`, model.url)}`
  await w.daemon()
  await w.startEntry({ harness: "claude", session, cwd: repo, env: flags, timeoutMs: 120_000 })
  let entryId = ""
  await until(
    "the entry session in vibest ls",
    async () => {
      entryId =
        (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).find(
          (e) => e.agent === "main",
        )?.id ?? ""
      return entryId !== ""
    },
    60_000,
  )
  const projectId = row<{ p: number }>(w, "SELECT project_id AS p FROM session WHERE id = ?", entryId)!.p
  const conversation = () =>
    row<{ c: string | null }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, entryId)?.c ?? null
  const pane = () => {
    const runtime = row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, entryId)?.r ?? "{}"
    const id = (JSON.parse(runtime) as { id?: string }).id ?? ""
    return id.split("/")[1] ?? ""
  }
  const screen = async () => {
    const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })
    return String((r.read as { text?: string } | undefined)?.text ?? "")
  }
  await answerFolderTrust(screen, (key) => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: [key] }))
  await until("the entry session's first poll", () => conversation() !== null, 120_000).catch(async (e: Error) => {
    const peek = await w.vibest(["peek", entryId, "--lines", "40"], { cwd: repo })
    const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
    throw new Error(`${e.message}; its screen:\n${peek.stdout}${peek.stderr}\nvibestd.log:\n${log.slice(-3000)}`)
  })
  const delivered = (from: string) =>
    row<{ n: number }>(
      w,
      "SELECT count(*) AS n FROM inbox WHERE session_id = ? AND sender_session_id = ? AND status = 'delivered'",
      entryId,
      from,
    )?.n ?? 0
  const shown = async (line: string, marker: string) => {
    let entries: Awaited<ReturnType<typeof transcript>> = []
    await until(
      `the ${marker} line and its context in the entry session's conversation`,
      async () => {
        entries = await transcript(w, repo, config)
        const lineShown = entries.some((e) => e.type === "user" && e.text.includes(line))
        const fullTextAttachedByPromptSubmitHook = entries.some(
          (e) =>
            e.type === "attachment" && e.raw.includes("hook_additional_context") && e.raw.includes(`done-${marker}`),
        )
        return lineShown && fullTextAttachedByPromptSubmitHook
      },
      90_000,
    ).catch(async (e: Error) => {
      const tail = entries.slice(-8).map((x) => `${x.type}: ${x.raw.slice(0, 300)}`)
      throw new Error(`${e.message}; the conversation ends with:\n${tail.join("\n")}\nits screen:\n${await screen()}`)
    })
    return entries
  }
  const start = async (title: string, marker: string) =>
    (
      JSON.parse(
        await w.okViaEntry(["run", "pi", "--env", env, "--title", title, "--", ask(marker)], {
          cwd: repo,
          timeoutMs: 60_000,
        }),
      ) as { id: string }
    ).id
  const result = async (sub: string, title: string, marker: string, before: number) => {
    await until(`the ${marker} result delivered`, () => delivered(sub) > before, 180_000)
    const shortId = sub.slice(0, 8)
    return shown(`General Agent "${title}" sent a message (${shortId})`, marker)
  }
  const enter = () => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })
  const typeText = (text: string) => herdr(socket, "pane.send_text", { pane_id: pane(), text })
  const typeIn = (text: string) => typeAndEnter(screen, { text: typeText, enter }, text)
  const typeInShell = async (text: string) => {
    await typeText(text)
    await enter()
  }
  const claudePid = async () => {
    const r = await herdr(socket, "pane.process_info", { pane_id: pane() })
    const info = (r.process_info ?? {}) as {
      shell_pid?: number
      foreground_processes?: Array<{ pid: number; name: string; argv0?: string | null; cmdline?: string | null }>
    }
    return (info.foreground_processes ?? []).find(
      (p) => p.pid !== info.shell_pid && path.basename(p.argv0 ?? p.cmdline?.split(" ")[0] ?? "") === "claude",
    )?.pid
  }
  return {
    repo,
    entryId,
    flags,
    config,
    projectId,
    conversation,
    delivered,
    start,
    result,
    typeIn,
    typeInShell,
    enter,
    claudePid,
    screen,
    close: async () => {
      anthropic.stop()
      await dropHerdrSession(w, session)
    },
  }
}

export const curl = async (
  w: World,
  route: string,
  who: { entryId: string; projectId: number | string; protocol?: string },
  harness = "claude",
  body: object = {},
) => {
  const headers = {
    "vibest-protocol": who.protocol ?? String(PROTOCOL),
    "vibest-caller": "session",
    "vibest-session-id": who.entryId,
    "vibest-project-id": String(who.projectId),
    "vibest-agent": "entry",
    "vibest-harness": harness,
    "content-type": "application/json",
  }
  const r = await w.run(w.root, [
    "curl",
    "-s",
    "-w",
    "\n%{http_code}",
    "--unix-socket",
    path.join(w.vibestHome, "vibest-http.sock"),
    "-X",
    "POST",
    ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
    "-d",
    JSON.stringify(body),
    `http://vibestd${route}`,
  ])
  const at = r.stdout.lastIndexOf("\n")
  return { status: Number(r.stdout.slice(at + 1)), body: JSON.parse(r.stdout.slice(0, at) || "null") as unknown }
}

const heldSubagent = async (w: World, pastWindow: boolean) => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const model = heldModel()
  const session = `${w.herdrSession}-held`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  try {
    const repo = await project(w, "held")
    const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-held", model.url)}`
    await w.daemon()
    await w.startEntry({
      harness: "pi",
      session,
      cwd: repo,
      env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
      timeoutMs: 60_000,
    })
    const sub = (
      JSON.parse(
        await w.okViaEntry(["run", "pi", "--session", session, "--env", env, "--", ask("held")], {
          cwd: repo,
          timeoutMs: 60_000,
        }),
      ) as { id: string }
    ).id
    const started = Date.now()
    await until("the subagent's execution held by the model", () => model.held() > 0, 60_000)
    const named = async () =>
      ((await herdr(socket, "agent.list", {})).agents as Array<{ name?: string | null }>).some(
        (a) => a.name === agentName(sub),
      )
    const exited = () =>
      row<{ e: number | null }>(w, `SELECT exited_at AS e FROM ${SESSIONS} s WHERE id = ?`, sub)?.e ?? null
    const log = async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")).slice(-3000)
    const kept = async () => {
      expect(exited() === null, `the subagent was recorded as exited at ${exited()}; vibestd.log:\n${await log()}`)
      expect(await named(), `herdr no longer names the subagent ${agentName(sub)}; vibestd.log:\n${await log()}`)
    }
    if (pastWindow)
      while (Date.now() - started < HERDR_AGENT_START_TIMEOUT_MS + 15_000) {
        await Bun.sleep(5_000)
        await kept()
      }
    else {
      const terminal = () =>
        (
          JSON.parse(
            row<{ r: string | null }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, sub)?.r ?? "{}",
          ) as {
            id?: string
          }
        ).id ?? ""
      await until("its terminal recorded while the first execution is held", () => terminal() !== "", 60_000)
      expect(model.held() > 0, "the first execution ended before the terminal was recorded")
      await kept()
    }
    const peek = await w.vibest(["peek", sub], { cwd: repo })
    expect(peek.code === 0, `vibest peek ${sub} exited ${peek.code}: ${peek.stderr}${peek.stdout}`)
    model.release()
    await until("the held execution's reply", async () => (await replyOf(w, sub, repo)).includes("done-held"), 60_000)
  } finally {
    model.stop()
    await dropHerdrSession(w, session)
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "S15",
    covers: ["S11", "D7"],
    title:
      "Claude entry session over HTTP: two subagents' lines and contexts match one to one, a result arriving mid-execution still arrives, curl --unix-socket take (a batch nobody accepts ends not_started and fails its row) / project and protocol mismatch, and delivery after `vibest daemon restart`; S11: a result still arrives as one line with its context after /clear, and after the entry session is stopped (SIGTERM) and `vibest` resumes it in the same pane",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude", "curl"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      const go = path.join(w.root, "cmmid-go")
      const wait = `until [ -e ${go} ]; do sleep 1; done`
      let c: Awaited<ReturnType<typeof claudeEntry>> | undefined
      let stopped: number | undefined
      try {
        c = await claudeEntry(w, "cmtwo", model, (r): Step => {
          const last = text(lastUser(r))
          if (last.includes(wait)) return { tool: "Bash", input: { command: wait } }
          return last.includes('"tool_result"') ? "waited" : "ok"
        })
        const a = await c.start("Answer probe alpha", "cmalpha")
        await c.result(a, "Answer probe alpha", "cmalpha", 0)
        const b = await c.start("Answer probe beta", "cmbeta")
        const entries = await c.result(b, "Answer probe beta", "cmbeta", 0)
        const contexts = entries.filter((e) => e.type === "attachment" && e.raw.includes("hook_additional_context"))
        for (const [own, other] of [
          ["cmalpha", "cmbeta"],
          ["cmbeta", "cmalpha"],
        ])
          expect(
            contexts.filter((e) => e.raw.includes(`done-${own}`)).every((e) => !e.raw.includes(`done-${other}`)),
            `a context with done-${own} also holds done-${other}`,
          )
        for (const [sub, title] of [
          [a, "Answer probe alpha"],
          [b, "Answer probe beta"],
        ] as const) {
          const line = `General Agent "${title}" sent a message (${sub.slice(0, 8)})`
          const n = entries.filter((e) => e.type === "user" && e.text.includes(line)).length
          expect(n === 1, `the line for ${sub} shows ${n} times`)
        }

        const exchange = async (marker: string) => {
          const before = c!.delivered(b)
          await w.ok(["send", b, "--", ask(marker)], { cwd: c!.repo })
          await c!.result(b, "Answer probe beta", marker, before)
        }
        const first = c.conversation()
        await c.typeIn("/clear")
        await until("the conversation after /clear", () => c!.conversation() !== first, 60_000)
        await exchange("cmcleared")
        const cleared = c.conversation()
        const pid = await c.claudePid()
        expect(pid !== undefined, "no claude process in the entry session's pane")
        process.kill(pid!, "SIGTERM")
        await until(
          "the entry session's Claude exited",
          async () => (await c!.claudePid()) === undefined,
          30_000,
        ).catch(async (e: Error) => {
          throw new Error(
            `${e.message}; pid ${pid} alive ${alive(pid!)}, now ${await c!.claudePid()}; its screen:\n${await c!.screen()}`,
          )
        })
        await c.typeInShell([binary, "--harness", "claude"].join(" "))
        await until(
          "Claude again in the entry session's pane",
          async () => (await c!.claudePid()) !== undefined,
          60_000,
        )
        await exchange("cmresumed")
        expect(c.conversation() === cleared, `resumed conversation ${c.conversation()}; before the stop ${cleared}`)

        await c.typeIn(`Wait for the go file: ${wait}`)
        await until(
          "the entry session's own execution running",
          async () =>
            (await transcript(w, c!.repo, c!.config)).some((e) => e.type === "assistant" && e.raw.includes(go)),
          60_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; its screen:\n${await c!.screen()}`)
        })
        const results = () =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM inbox WHERE session_id = ? AND sender_session_id = ?",
            c!.entryId,
            a,
          )?.n ?? 0
        const before = c.delivered(a)
        const queued = results()
        await w.ok(["send", a, "--", ask("cmmid")], { cwd: c.repo })
        await until(
          "the cmmid result queued while the entry session's execution runs",
          () => results() > queued,
          180_000,
        )
        await fs.writeFile(go, "")
        const mid = await c.result(a, "Answer probe alpha", "cmmid", before)
        const midAt = mid.findIndex(
          (e) => e.type === "attachment" && e.raw.includes("hook_additional_context") && e.raw.includes("done-cmmid"),
        )
        await until(
          "the entry session's execution on the cmmid result ended",
          async () =>
            (await transcript(w, c!.repo, c!.config))
              .slice(midAt)
              .some((e) => e.type === "system" && e.raw.includes('"subtype":"turn_duration"')),
          180_000,
        )

        stopped = await c.claudePid()
        expect(stopped !== undefined, "no claude process in the entry session's pane")
        process.kill(stopped!, "SIGSTOP")
        const who = { entryId: c.entryId, projectId: c.projectId }
        const status = (id: number) => row<{ s: string }>(w, "SELECT status AS s FROM inbox WHERE id = ?", id)?.s
        await w.ok(["send", a, "--", ask("cmcurl")], { cwd: c.repo })
        let taken: { execution: number; ids: Array<number>; line: string; text: string } = {
          execution: 0,
          ids: [],
          line: "",
          text: "",
        }
        await until(
          "a curl take hands the result out",
          async () => {
            const r = await curl(w, "/inbox/take", who)
            expect(r.status === 200 || r.status === 204, `take answered ${r.status}: ${JSON.stringify(r.body)}`)
            if (r.status === 200) taken = r.body as typeof taken
            return taken.ids.length > 0
          },
          180_000,
        )
        expect(taken.text.includes("done-cmcurl"), `the taken text: ${taken.text}`)
        const id = taken.ids[0]!
        expect(status(id) === "delivered", `after the take the row is ${status(id)}`)
        const again = await curl(w, "/inbox/take", who)
        expect(again.status === 204, `a second take answered ${again.status}: ${JSON.stringify(again.body)}`)
        const other = await curl(w, "/inbox/take", { ...who, projectId: "00000000-0000-4000-8000-000000000000" })
        expect(other.status === 403, `another project's take answered ${other.status}`)
        const old = await curl(w, "/inbox/take", { ...who, protocol: "3" })
        expect(
          old.status === 409 && (old.body as { action?: string }).action === "vibest update",
          `an older protocol's take answered ${old.status}: ${JSON.stringify(old.body)}`,
        )
        const ps = (pid: number) =>
          Bun.spawnSync(["ps", "-o", "stat=,pgid=,tpgid=", "-p", String(pid)])
            .stdout.toString()
            .trim()
            .split(/\s+/)
        const [, pgid, tpgid] = ps(stopped!)
        if (pgid === tpgid) process.kill(stopped!, "SIGCONT")
        else await c.typeInShell("fg")
        const resumed = stopped!
        stopped = undefined
        await until(
          "the entry session running in the foreground again",
          () => {
            const [stat, pgid, tpgid] = ps(resumed)
            return !stat?.startsWith("T") && pgid === tpgid
          },
          15_000,
        )

        await until(
          "the batch nobody accepted ends not_started and its row fails",
          () => status(id) === "failed",
          60_000,
        )
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: c.repo, timeoutMs: 60_000 })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        const after = c.delivered(b)
        await w.ok(["send", b, "--", ask("cmafter")], { cwd: c.repo })
        await c.result(b, "Answer probe beta", "cmafter", after)
      } finally {
        if (stopped !== undefined) process.kill(stopped, "SIGCONT")
        model.stop()
        await c?.close()
      }
    },
  },
  {
    id: "S12",
    covers: ["D7"],
    title:
      "Pi entry session: each result reaches the real Pi TUI as its own execution: a Claude subagent's first and second result, and one after `vibest daemon restart`",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const claude = fakeAnthropic((r) => {
        const task = r.tools.length > 0 ? taskIn(r) : undefined
        return task ? claudeSendOrReply(r, `done-${task}`) : "ok"
      })
      const model = delegatingModel(`claude ${envArgs(await claudeEnv(w, "inbox", claude.url)).join(" ")}`)
      const session = `${w.herdrSession}-inbox`
      try {
        const repo = await project(w, "inbox")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-inbox", model.url)}`
        await w.stopDaemon()
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
          timeoutMs: 60_000,
        })
        const entryRows = async () =>
          (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).filter(
            (e) => e.agent === "main",
          )
        await until("the entry session in vibest ls", async () => (await entryRows()).length === 1, 30_000)
        const reached = (what: string, marker: string) =>
          until(what, () => model.seen.some((m) => m.includes("<agent-") && m.includes(marker)), 180_000).catch(
            (e: Error) => {
              throw new Error(`${e.message}; the entry session's model saw: ${JSON.stringify(model.seen, null, 1)}`)
            },
          )
        await w.okViaEntry(["run", "pi", "--env", env, ask("zero")], { cwd: repo, timeoutMs: 60_000 })
        await reached("the entry session's execution on the first result", "done-zero")
        await reached("the entry session's execution on the Claude subagent's first result", "done-one")
        await reached("the entry session's execution on the Claude subagent's second result", "done-two")
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: repo, timeoutMs: 60_000 })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        await w.ok(["send", model.sessionId(), ask("three")], { cwd: repo })
        await reached("the entry session's execution on a result after vibestd restarted", "done-three")
        const entryId = (await entryRows())[0]!.id
        await expectReplied(w, model.sessionId())
        const toEntry = () =>
          rows<{ status: string }>(
            w,
            "SELECT status FROM inbox WHERE session_id = ? AND kind = 'send' AND sender_session_id IS NOT NULL",
            entryId,
          ).map((r) => r.status)
        await until(
          "the entry session's four sends delivered",
          () => JSON.stringify(toEntry()) === JSON.stringify(Array(4).fill("delivered")),
        ).catch(() => fail(`the entry session's send rows: ${JSON.stringify(toEntry())}`))
      } finally {
        model.stop()
        claude.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S49",
    covers: ["S45"],
    title:
      "a Pi subagent's vibest send to a Claude entry session (which polls) is one send row from the subagent to the entry session, delivered, with one inbox.queued and one inbox.moved to delivered; the entry session's conversation holds a line naming the subagent and an <agent-message> with its id and text",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      let c: Awaited<ReturnType<typeof claudeEntry>> | undefined
      let sender: ReturnType<typeof Bun.serve> | undefined
      try {
        c = await claudeEntry(w, "cmsend", model)
        const entryId = c.entryId
        sender = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          idleTimeout: 0,
          fetch: async (req) => {
            const { messages = [] } = (await req.json()) as { messages?: Array<{ role: string }> }
            return new Response(
              messages.some((m) => m.role === "tool")
                ? reply("done-cmsend\nstatus: completed")
                : toolCall("call1", "bash", { command: `${binary} send ${entryId} -- hello-claude` }),
              { headers: sseHeaders },
            )
          },
        })
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-cmsend-sender", `http://127.0.0.1:${sender.port}/v1`)}`
        const sub = (
          JSON.parse(
            await w.okViaEntry(
              ["run", "pi", "--env", env, "--title", "Send probe", "--", "send to the entry session"],
              {
                cwd: c.repo,
                timeoutMs: 60_000,
              },
            ),
          ) as { id: string }
        ).id
        const sent = () =>
          rows<{ id: number; status: string }>(
            w,
            "SELECT id, status FROM inbox WHERE sender_session_id = ? AND session_id = ? AND kind = 'send'",
            sub,
            entryId,
          )
        await until("the send delivered", () => sent().some((r) => r.status === "delivered"), 180_000)
        expect(sent().length === 1, `${sent().length} sends from ${sub}: ${JSON.stringify(sent())}`)
        const fact = (sql: string) =>
          row<{ n: number }>(
            w,
            `SELECT count(*) AS n FROM event WHERE aggregate = ? AND ${sql}`,
            entryId,
            sent()[0]!.id,
          )?.n
        expect(
          fact("type = 'inbox.queued' AND seq = ?") === 1 &&
            fact(
              "type = 'inbox.moved' AND json_extract(data, '$.inbox') = ? AND json_extract(data, '$.to') = 'delivered'",
            ) === 1,
          `the send ${sent()[0]!.id} has not exactly one inbox.queued and one inbox.moved to delivered`,
        )
        const line = `General Agent "Send probe"`
        await until(
          "the line and the <agent-message> in the entry session's conversation",
          async () => {
            const entries = await transcript(w, c!.repo, c!.config)
            return (
              entries.some((e) => e.type === "user" && e.text.includes(line)) &&
              entries.some(
                (e) =>
                  e.type === "attachment" &&
                  e.raw.includes("hook_additional_context") &&
                  e.raw.includes("<agent-message>") &&
                  e.raw.includes(sub) &&
                  e.raw.includes("hello-claude"),
              )
            )
          },
          90_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; its screen:\n${await c!.screen()}`)
        })
      } finally {
        sender?.stop(true)
        model.stop()
        await c?.close()
      }
    },
  },
  {
    id: "S18",
    title:
      "a Pi subagent whose first execution is still held already has its terminal (herdr's agent.start resolved before the execution ends): herdr names it s-<id>, vibest peek reads it, no exit is recorded, and its result arrives",
    run: (w) => heldSubagent(w, false),
  },
  {
    id: "S20",
    title:
      "ids: vibest run answers a UUID, herdr names the agent s-<30 hex>, result takes 8 characters and peek 12 (peek prints the terminal, at most N lines with --lines, and refuses an unknown id), and the system prompt is $TMPDIR/vibest/<id>/system-prompt.md",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      model.release()
      const session = `${w.herdrSession}-ids`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      try {
        const repo = await project(w, "ids")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-ids", model.url)}`
        await w.daemon()
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
          timeoutMs: 60_000,
        })
        const sub = (
          JSON.parse(
            await w.okViaEntry(["run", "pi", "--session", session, "--env", env, "--", ask("ids")], {
              cwd: repo,
              timeoutMs: 60_000,
            }),
          ) as { id: string }
        ).id
        expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sub), `run answered ${sub}`)
        await until(
          `herdr names ${agentName(sub)}`,
          async () =>
            ((await herdr(socket, "agent.list", {})).agents as Array<{ name?: string | null }>).some(
              (a) => a.name === agentName(sub),
            ),
          60_000,
        )
        await until(
          "the answer by its first 8 characters",
          async () => (await replyOf(w, sub.slice(0, 8), repo)).includes("done-ids"),
          60_000,
        )
        const peek = await w.vibest(["peek", sub.slice(0, 12)], { cwd: repo })
        expect(
          peek.code === 0 && peek.stdout.includes("done-ids"),
          `vibest peek ${sub.slice(0, 12)} exited ${peek.code}: ${peek.stderr}${peek.stdout}`,
        )
        const few = await w.ok(["peek", sub, "--lines", "3"], { cwd: repo })
        expect(few.trimEnd().split("\n").length <= 3, `--lines 3 printed:\n${few}`)
        const unknown = await w.vibest(["peek", "nope0000"], { cwd: repo })
        expect(unknown.code !== 0 && /NoSuchSession/.test(unknown.stderr), `${unknown.code}: ${unknown.stderr}`)
        const prompt = path.join(w.root, "tmp", "vibest", sub, "system-prompt.md")
        expect(await Bun.file(prompt).exists(), `no ${prompt}`)
        const short = await w.vibest(["result", sub.slice(0, 7)], { cwd: repo })
        expect(short.code !== 0 && short.stderr.includes("at least 8"), `7 characters: ${short.code} ${short.stderr}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S19",
    covers: ["D7", "S4"],
    title:
      "a Pi subagent with herdr's own Pi hook starts its first execution within seconds of vibest run: vibest daemon restart is not refused and vibest interrupt stops it while the model still holds the execution",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      const session = `${w.herdrSession}-confirm`
      try {
        const repo = await project(w, "confirm")
        const dir = await piDir(w, "pi-confirm", model.url)
        const hook = await w.run(w.root, ["herdr", "integration", "install", "pi"], {
          env: { PI_CODING_AGENT_DIR: dir },
        })
        expect(hook.code === 0, `herdr integration install pi exited ${hook.code}: ${hook.stderr}${hook.stdout}`)
        const env = `PI_CODING_AGENT_DIR=${dir}`
        await w.daemon()
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
          timeoutMs: 60_000,
        })
        const sub = (
          JSON.parse(
            await w.okViaEntry(["run", "pi", "--session", session, "--env", env, "--", ask("confirm")], {
              cwd: repo,
              timeoutMs: 60_000,
            }),
          ) as { id: string }
        ).id
        const log = async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")).slice(-3000)
        await until("the subagent's first execution at the model", () => model.held() > 0, 15_000)
        const t0 = Date.now()
        const restart = await w.tty(["daemon", "restart"], "y\n", {
          cwd: repo,
          timeoutMs: 60_000,
        })
        expect(
          restart.code === 0,
          `vibest daemon restart exited ${restart.code} after ${Date.now() - t0} ms: ${restart.stderr}${restart.stdout}\nvibestd.log:\n${await log()}`,
        )
        const stop = await w.vibest(["interrupt", sub], { cwd: repo, timeoutMs: 60_000 })
        expect(
          stop.code === 0 && stop.stdout.includes("interrupted"),
          `vibest interrupt exited ${stop.code}: ${stop.stderr}${stop.stdout}\nvibestd.log:\n${await log()}`,
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S26",
    covers: ["S2"],
    title:
      "latency: 3 executions of a busy Pi subagent, a queued send, then release, and 3 pane closes of idle subagents; every queued send goes out and every closed pane's process ends; the times (execution end to delivered, pane close to process.end) are recorded",
    run: async (w, evidence) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      const session = `${w.herdrSession}-s26`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const env = {}
      const logFile = path.join(w.vibestHome, "vibestd.log")
      const pct = (xs: Array<number>, p: number) => {
        const s = [...xs].sort((a, b) => a - b)
        const rank = (p / 100) * (s.length - 1)
        const lo = Math.floor(rank)
        const hi = Math.ceil(rank)
        return s[lo]! * (1 - (rank - lo)) + s[hi]! * (rank - lo)
      }
      const stats = (xs: Array<number>) => ({
        n: xs.length,
        p50: Math.round(pct(xs, 50)),
        p95: Math.round(pct(xs, 95)),
        max: Math.round(Math.max(...xs)),
      })
      const q = <A>(sql: string, ...args: Array<string | number>) => row<A>(w, sql, ...args)
      try {
        const repo = await project(w, "s26")
        const pi = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-s26", model.url)}`
        await w.daemon({ env })
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: pi.slice("PI_CODING_AGENT_DIR=".length) },
          processEnv: env,
          timeoutMs: 90_000,
        })
        const runSub = async (task: string) =>
          (
            JSON.parse(
              await w.okViaEntry(["run", "pi", "--session", session, "--env", pi, "--", ask(task)], {
                cwd: repo,
                env,
                timeoutMs: 90_000,
              }),
            ) as { id: string }
          ).id
        const sub = await runSub("busy")
        await until("the subagent's execution held", () => model.held() > 0, 60_000)
        const hook: Array<number> = []
        const delivery: Array<number> = []
        for (let i = 0; i < 3; i++) {
          const beforeEnd =
            q<{ id: number }>(
              "SELECT id FROM execution WHERE session_id = ? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1",
              sub,
            )?.id ?? 0
          const message = ask(`r${i}`)
          await w.ok(["send", sub, "--", message], { cwd: repo, env })
          await until(
            `pass ${i} queued`,
            () =>
              q<{ status: string }>(
                "SELECT status FROM inbox WHERE session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
                sub,
                message,
              )?.status === "pending",
            15_000,
          )
          const sent = q<{ id: number }>(
            "SELECT id FROM inbox WHERE session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
            sub,
            message,
          )
          expect(sent !== undefined, `pass ${i}: the queued send is not in the database`)
          const logAt = (await fs.readFile(logFile, "utf8").catch(() => "")).length
          const heldStreamsOfThisExecution = model.held()
          expect(heldStreamsOfThisExecution >= 1, `pass ${i}: no held execution`)
          for (let k = 0; k < heldStreamsOfThisExecution; k++) model.releaseOne()
          let receipt = 0
          let hookMs = 0
          let deliveryMs = 0
          await until(
            `pass ${i} settled`,
            async () => {
              if (receipt === 0) {
                const fresh = (await fs.readFile(logFile, "utf8").catch(() => "")).slice(logAt)
                const line = fresh.split("\n").find((l) => l.includes(`execution end ${sub}`))
                const ts = line === undefined ? undefined : /timestamp=(\S+)/.exec(line)?.[1]
                const parsed = ts === undefined ? Number.NaN : Date.parse(ts)
                if (Number.isFinite(parsed)) receipt = parsed
                else if (line !== undefined) receipt = Date.now()
              }
              const end = q<{ at: number }>(
                "SELECT ended_at AS at FROM execution WHERE session_id = ? AND outcome IS NOT NULL AND id > ? ORDER BY id LIMIT 1",
                sub,
                beforeEnd,
              )
              const delivered = q<{ at: number }>(
                "SELECT at FROM event WHERE aggregate = ? AND type = 'inbox.moved' AND data ->> '$.inbox' = ? AND data ->> '$.to' = 'delivered' ORDER BY seq LIMIT 1",
                sub,
                sent!.id,
              )
              if (!Number.isFinite(receipt) || receipt === 0 || end === undefined || delivered === undefined)
                return false
              hookMs = end.at - receipt
              deliveryMs = delivered.at - end.at
              return true
            },
            20_000,
          )
          hook.push(hookMs)
          delivery.push(deliveryMs)
          await until("the next execution held", () => model.held() > 0, 30_000)
        }
        model.release()
        const closes: Array<number> = []
        for (let i = 0; i < 3; i++) {
          const id = await runSub(`c${i}`)
          await until(
            `subagent ${i} idle`,
            () => {
              const open = q<{ id: number }>("SELECT id FROM execution WHERE session_id = ? AND outcome IS NULL", id)
              const ended = q<{ id: number }>(
                "SELECT id FROM execution WHERE session_id = ? AND outcome IS NOT NULL LIMIT 1",
                id,
              )
              return open === undefined && ended !== undefined
            },
            90_000,
          )
          const runtime = q<{ runtime: string | null }>(
            `SELECT runtime AS runtime FROM ${SESSIONS} s WHERE id = ?`,
            id,
          )?.runtime
          const pane = ((JSON.parse(runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1]
          expect(pane !== undefined && pane !== "", `no pane for ${id} (${runtime})`)
          const t0 = Date.now()
          await herdr(socket, "pane.close", { pane_id: pane })
          let at = 0
          await until(
            `process.end ${i}`,
            () => {
              const ended = q<{ at: number }>(
                "SELECT ended_at AS at FROM process WHERE session_id = ? AND end_reason != 'superseded' ORDER BY id DESC LIMIT 1",
                id,
              )
              if (ended === undefined) return false
              at = ended.at
              return true
            },
            20_000,
          )
          closes.push(at - t0)
        }
        const out = {
          hookReceiptToExecutionEndMs: stats(hook),
          executionEndToDeliveredMs: stats(delivery),
          paneCloseToProcessEndMs: stats(closes),
        }
        await writeEvidence(path.join(evidence, "latency.json"), `${JSON.stringify(out, null, 2)}\n`)
        console.log(`S26 ${JSON.stringify(out)}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default [
  ...checks,
  {
    id: "S18-slow",
    tier: "slow",
    title:
      "a Pi subagent whose first execution outlasts herdr's 120 s agent.start window keeps its terminal: herdr still names it s-<id>, vibest peek reads it, no exit is recorded, and its result arrives",
    run: (w) => heldSubagent(w, true),
  } satisfies Check,
]
