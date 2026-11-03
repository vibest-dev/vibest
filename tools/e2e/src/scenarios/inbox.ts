// Delivery between a main agent and its subagents, every agent on the fake model (../fake-model.ts): Pi through a
// models.json provider, Claude Code through ANTHROPIC_BASE_URL with a CLAUDE_CONFIG_DIR of the check's own, so no real
// model, login or user setting is used. The Claude main agent's inbox over HTTP (feature-map S11, S15), the Pi main
// agent's (S12), and the delivery matrix (S17-<main>-<subagent>). The fake model drives a main agent as the delegate
// skill does: `vibest run`, then `vibest send` on the result. vibestd, herdr and the harnesses are the real ones.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { claudeEnv, fakeServer, type Message, piDir } from "../fake-model.ts"
import { expect, row, Skip, until, type World } from "../world.ts"

type Entry = { id: string; agent: string }
type Harness = "claude" | "pi"

const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`
const AGENT_ID = /<agent-id>(\w+)<\/agent-id>/
/** The messages of the turn a request continues: everything after the agent's last reply. */
const turnOf = (messages: Array<Message>) => messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1)
/** What reached the agent as input: user messages, and Claude's hook context (system messages in the conversation). */
const said = (messages: Array<Message>) =>
  messages.filter((m) => m.role === "user" || m.role === "system").map((m) => m.text)
/** A main agent's request: a delivery is in its conversation (a subagent's never holds one). */
const isMain = (messages: Array<Message>) => said(messages).some((t) => AGENT_ID.test(t))

/**
 * The model of S11, S12 and S15. A turn answers its new messages: a task with its two lines; "Run the shell command
 * `…`" with that command; the first result with `vibest run <sub>`; that subagent's first result with `vibest send`;
 * anything else with "ok". `seen` holds each turn request's new messages.
 */
const fakeModel = (sub: string) => {
  const seen: Array<string> = []
  let sessionId = ""
  const server = fakeServer((messages) => {
    const turn = turnOf(messages)
    const body = turn.map((m) => m.text).join("\n")
    seen.push(body)
    if (turn.some((m) => m.role === "tool")) {
      const id = /"id":\s*\\?"(\w+)\\?"/.exec(body)?.[1]
      if (id && !sessionId) sessionId = id
      return { text: "ok" }
    }
    const command = /Run the shell command `([^`]+)`/.exec(body)?.[1]
    if (command) return { bash: command }
    if (body.includes("<agent-")) {
      if (body.includes("done-zero")) return { bash: `vibest run ${sub} -- '${ask("one")}'` }
      if (body.includes("done-one")) return { bash: `vibest send ${sessionId} -- '${ask("two")}'` }
      return { text: "ok" }
    }
    const task = /done-(\w+)/.exec(body)
    return { text: task ? `done-${task[1]}\nstatus: completed` : "ok" }
  })
  return { seen, sessionId: () => sessionId, ...server }
}

/** A git repository of its own under the world's root: a project of its own, so its main agent is this check's. */
const project = async (w: World, name: string) => {
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

/** One call to a herdr session's socket API: newline-delimited JSON, one response per connection (effect-herdr-sdk). */
const herdr = (socket: string, method: string, params: object) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = crypto.randomUUID()
    let buffer = ""
    Bun.connect({
      unix: socket,
      socket: {
        open: (s) => void s.write(`${JSON.stringify({ id, method, params })}\n`),
        data: (s, chunk) => {
          buffer += Buffer.from(chunk).toString("utf8")
          for (const line of buffer.split("\n").slice(0, -1)) {
            const m = JSON.parse(line) as { id?: string; result?: Record<string, unknown>; error?: unknown }
            if (m.id !== id) continue
            s.end()
            if (m.error) reject(new Error(`herdr ${method}: ${JSON.stringify(m.error)}`))
            else resolve(m.result ?? {})
          }
          buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })

/** Stops and deletes a herdr session this check started, as World.close does for the run's own. */
const dropHerdrSession = async (w: World, session: string) => {
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

/** Every entry of the Claude conversations kept for `cwd` in CLAUDE_CONFIG_DIR `config`. */
const transcript = async (config: string, cwd: string) => {
  const dir = path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  const files = (await fs.readdir(dir).catch(() => [] as Array<string>)).filter((f) => f.endsWith(".jsonl"))
  const entries: Array<{ type?: string; raw: string; text: string }> = []
  for (const f of files)
    for (const raw of (await fs.readFile(path.join(dir, f), "utf8")).split("\n").filter(Boolean)) {
      const e = JSON.parse(raw) as { type?: string; message?: { content?: unknown } }
      const content = e.message?.content
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c: { text?: string }) => c.text ?? "").join("")
            : ""
      entries.push({ type: e.type, raw, text })
    }
  return entries
}

/**
 * A main agent on `harness` (Claude unless named) in a herdr session of its own, for project `name`, every agent of it on
 * the fake `model`; a Claude one trusted and polling. `close` drops the session.
 */
const claudeMain = async (
  w: World,
  name: string,
  model: { readonly url: string; readonly anthropic: string },
  harness: Harness = "claude",
) => {
  const session = `${w.herdrSession}-${name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const repo = await project(w, name)
  /** A Pi agent's `--env`: its models.json names only the fake model. */
  const env = `PI_CODING_AGENT_DIR=${await piDir(w.root, `pi-${name}`, model.url)}`
  // Panes get the herdr server's environment, which gets vibestd's: both start here, vibestd with Claude on the fake
  // model (a CLAUDE_CONFIG_DIR of this check's, ANTHROPIC_BASE_URL) and an empty ZDOTDIR (the pane shell keeps this
  // build first).
  const zdot = path.join(w.root, `zdotdir-${name}`)
  await fs.mkdir(zdot, { recursive: true })
  const claudeFake = await claudeEnv(w.root, `claude-${name}`, model.anthropic)
  const daemonEnv = { ...claudeFake, ZDOTDIR: zdot }
  await w.stopDaemon()
  await w.ok(["daemon"], { env: daemonEnv })
  await w.ok(["--harness", harness, "--session", session, "--headless", ...(harness === "pi" ? ["--env", env] : [])], {
    cwd: repo,
    timeoutMs: 120_000,
    env: daemonEnv,
  })
  let main = ""
  await until(
    "the main agent in vibest ls",
    async () => {
      main = (await w.json<Array<Entry>>(["ls"], { cwd: repo })).find((e) => e.agent === "main")?.id ?? ""
      return main !== ""
    },
    60_000,
  )
  const projectId = row<{ p: number }>(w, "SELECT project_id AS p FROM session WHERE id = ?", main)!.p
  const conversation = () =>
    row<{ c: string | null }>(w, "SELECT harness_session_id AS c FROM session WHERE id = ?", main)?.c ?? null
  const pane = () => {
    const runtime = row<{ r: string }>(w, "SELECT runtime AS r FROM session WHERE id = ?", main)?.r ?? "{}"
    const id = (JSON.parse(runtime) as { id?: string }).id ?? ""
    return id.split("/")[1] ?? ""
  }
  const screen = async () => {
    const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })
    return String((r.read as { text?: string } | undefined)?.text ?? "")
  }
  if (harness === "claude") {
    // A new folder: Claude asks whether to trust it (vibest answers that menu for subagents, the person for the main
    // agent). Hooks modules load only once it is trusted.
    await until(
      "Claude's trust question or its input box",
      async () => /trust this folder|❯\s*$/m.test(await screen()),
      60_000,
    )
    // As the Claude adapter answers it for a subagent: down until Yes is selected, then enter.
    for (let i = 0; i < 10 && /trust this folder/.test(await screen()); i++) {
      const yes = /^\s*❯.*Yes, I trust this folder/m.test(await screen())
      await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: [yes ? "enter" : "down"] })
      await Bun.sleep(1_000)
    }
    // The plugin's first poll names its conversation: it is polling.
    await until("the main agent's first poll", () => conversation() !== null, 120_000).catch(async (e: Error) => {
      const peek = await w.vibest(["peek", main, "--lines", "40"], { cwd: repo })
      const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
      throw new Error(`${e.message}; its screen:\n${peek.stdout}${peek.stderr}\nvibestd.log:\n${log.slice(-3000)}`)
    })
  }
  const delivered = (from: string) =>
    row<{ n: number }>(
      w,
      "SELECT count(*) AS n FROM inbox WHERE recipient_session_id = ? AND sender_id = ? AND delivery_status = 'delivered'",
      main,
      from,
    )?.n ?? 0
  /** The subagent's line shown as a user entry, and its full text attached as hook context. */
  const shown = async (line: string, marker: string) => {
    let entries: Awaited<ReturnType<typeof transcript>> = []
    await until(
      `the ${marker} line and its context in the main agent's conversation`,
      async () => {
        entries = await transcript(claudeFake.CLAUDE_CONFIG_DIR, repo)
        return (
          entries.some((e) => e.type === "user" && e.text.includes(line)) &&
          // The plugin's own prompt.submit hook attached the full text: Claude keeps it as this attachment.
          entries.some(
            (e) =>
              e.type === "attachment" && e.raw.includes("hook_additional_context") && e.raw.includes(`done-${marker}`),
          )
        )
      },
      90_000,
    ).catch((e: Error) => {
      const tail = entries.slice(-8).map((x) => `${x.type}: ${x.raw.slice(0, 300)}`)
      throw new Error(`${e.message}; the conversation ends with:\n${tail.join("\n")}`)
    })
    return entries
  }
  /** A Pi subagent titled `title`, started on task `marker`; its id. */
  const start = async (title: string, marker: string) =>
    (
      JSON.parse(
        await w.ok(["run", "pi", "--env", env, "--title", title, "--", ask(marker)], { cwd: repo, timeoutMs: 60_000 }),
      ) as { id: string }
    ).id
  /** One result from subagent `sub` reaches the main agent: its line as the prompt, its full text as context. */
  const result = async (sub: string, title: string, marker: string, before: number) => {
    await until(`the ${marker} result delivered`, () => delivered(sub) > before, 180_000)
    return shown(`General Agent "${title}" completed (${sub})`, marker)
  }
  const typeIn = async (text: string) => {
    await herdr(socket, "pane.send_text", { pane_id: pane(), text })
    await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })
  }
  /** The main agent's Claude process in its pane. */
  const claude = async () => {
    const r = await herdr(socket, "pane.process_info", { pane_id: pane() })
    const info = (r.process_info ?? {}) as {
      shell_pid?: number
      foreground_processes?: Array<{ pid: number; name: string; argv0?: string | null; cmdline?: string | null }>
    }
    return (info.foreground_processes ?? []).find(
      (p) => p.pid !== info.shell_pid && /claude/i.test(`${p.name} ${p.argv0 ?? ""} ${p.cmdline ?? ""}`),
    )?.pid
  }
  return {
    repo,
    env,
    daemonEnv,
    config: claudeFake.CLAUDE_CONFIG_DIR,
    screen,
    main,
    projectId,
    conversation,
    delivered,
    start,
    result,
    typeIn,
    claude,
    close: () => dropHerdrSession(w, session),
  }
}

/** One POST to vibestd's HTTP socket with curl, as the main agent's plugin sends it. */
const curl = async (
  w: World,
  route: string,
  who: { main: string; projectId: number | string; protocol?: string },
  body: object = {},
) => {
  const headers = {
    "vibest-protocol": who.protocol ?? "4",
    "vibest-caller": "session",
    "vibest-session-id": who.main,
    "vibest-project-id": String(who.projectId),
    "vibest-agent": "coordinator",
    "vibest-harness": "claude",
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

/**
 * One cell row of the delivery matrix (docs/testing/feature-map.md): a `main` main agent and a `sub` subagent, both on
 * the fake model, and the five deliveries, each arriving exactly once at the right agent. Each delivery is reported on
 * its own line; the check fails if any did.
 */
const matrix = (main: Harness, sub: Harness): Check => ({
  id: `S17-${main}-${sub}`,
  title: `delivery matrix, ${main} main agent and ${sub} subagent on the fake model: a result, a second result after the main agent's \`vibest send\`, a send queued while the subagent is busy, a \`vibest report\` while the main agent is idle and mid-turn, and a result after \`vibest daemon restart\`, each arriving once at the right agent`,
  run: async (w) => {
    for (const bin of new Set([main, sub, "herdr"])) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
    // Every turn request of both agents, in order, with what reached that agent as input.
    const requests: Array<{ main: boolean; said: Array<string> }> = []
    /** The main agent's model is mid-turn (its answer held back) while this is set. */
    let holding = false
    let reportedMidTurn: boolean | undefined
    const model = fakeServer(async (messages) => {
      const toMain = isMain(messages)
      const input = said(messages)
      requests.push({ main: toMain, said: input })
      const turn = turnOf(messages)
      const body = turn.map((m) => m.text).join("\n")
      const tool = turn.some((m) => m.role === "tool")
      if (toMain) {
        if (tool) return { text: "ok" }
        // The first result: send the subagent its next task, as the delegate skill does.
        if (body.includes("done-one")) return { bash: `vibest send ${AGENT_ID.exec(body)?.[1]} -- '${ask("two")}'` }
        // This result keeps the main agent in a turn for 30 s: the report sent meanwhile arrives mid-turn.
        if (body.includes("done-hold")) {
          holding = true
          await Bun.sleep(30_000)
          holding = false
        }
        return { text: "ok" }
      }
      const task = input.findLast((u) => /done-\w+/.test(u)) ?? ""
      const marker = /done-(\w+)/.exec(task)?.[1] ?? "none"
      if (tool) return { text: `done-${marker}\nstatus: completed` }
      if (task.includes("report-")) {
        if (marker === "mid") reportedMidTurn = holding
        return { bash: `vibest report -- 'rep-${marker}'` }
      }
      // A slow task keeps the subagent busy for 20 s.
      if (task.includes("slow-")) await Bun.sleep(20_000)
      return { text: `done-${marker}\nstatus: completed` }
    })
    const outcomes: Array<string> = []
    let c: Awaited<ReturnType<typeof claudeMain>> | undefined
    try {
      c = await claudeMain(w, `m${main}${sub}`, model, main)
      const { repo, env } = c
      const lastOf = (toMain: boolean) => requests.findLast((r) => r.main === toMain)?.said ?? []
      /** How many of an agent's inputs hold `marker`, in its latest request (its whole conversation). */
      const count = (toMain: boolean, marker: string) => lastOf(toMain).filter((u) => u.includes(marker)).length
      const arrives = async (what: string, marker: string) => {
        await until(what, () => count(true, marker) > 0, 180_000)
        // Settle: a duplicate would arrive right after.
        await Bun.sleep(5_000)
        expect(count(true, marker) === 1, `${marker} reached the main agent ${count(true, marker)} times`)
        expect(
          requests.every((r) => r.main || !r.said.some((u) => u.includes(marker) && AGENT_ID.test(u))),
          `${marker} reached the subagent`,
        )
      }
      const step = async (n: number, name: string, body: () => Promise<void>) => {
        try {
          await body()
          outcomes.push(`${n} pass`)
        } catch (e) {
          // Both agents' screens, as they are now: evidence for the failure, never an input to the check.
          const screens = [
            await c!.screen().catch((x: Error) => x.message),
            (await w.vibest(["peek", id, "--lines", "25"], { cwd: repo })).stdout,
          ]
          outcomes.push(
            `${n} fail: ${e instanceof Error ? e.message : String(e)}\nmain agent:\n${screens[0]}\nsubagent:\n${screens[1]}`,
          )
        }
        console.log(`     ${main} x ${sub} delivery ${n} (${name}): ${outcomes.at(-1)}`)
      }
      const id = (
        JSON.parse(
          await w.ok(
            ["run", sub, ...(sub === "pi" ? ["--env", env] : []), "--title", "Matrix probe", "--", ask("one")],
            {
              cwd: repo,
              timeoutMs: 60_000,
            },
          ),
        ) as { id: string }
      ).id
      const send = (message: string) => w.ok(["send", id, "--", message], { cwd: repo })
      const inboxRow = (marker: string) =>
        row<{ s: string }>(
          w,
          "SELECT delivery_status AS s FROM inbox WHERE recipient_session_id = ? AND content LIKE ?",
          id,
          `%${marker}%`,
        )?.s

      await step(1, "a subagent's result", () => arrives("the first result at the main agent", "done-one"))
      await step(2, "a second result after the main agent's send", async () => {
        await until("the main agent's vibest send queued", () => inboxRow("done-two") !== undefined, 60_000)
        await arrives("the second result at the main agent", "done-two")
        expect(count(false, "done-two") === 1, `the send reached the subagent ${count(false, "done-two")} times`)
      })
      await step(3, "a send queued while the subagent is busy", async () => {
        await send(`slow-busy: ${ask("busy")}`)
        await until("the subagent busy on its slow task", () => count(false, "slow-busy") > 0, 60_000)
        await send(ask("queued"))
        await Bun.sleep(3_000)
        expect(count(false, "done-queued") === 0, "the queued send reached the subagent mid-turn")
        const queued = inboxRow("done-queued")
        expect(queued === "pending", `while the subagent is busy the queued send is ${queued}`)
        await arrives("the busy task's result at the main agent", "done-busy")
        await arrives("the queued send's result at the main agent", "done-queued")
        const conversation = lastOf(false)
        const at = (marker: string) => conversation.findIndex((u) => u.includes(marker))
        expect(
          count(false, "done-queued") === 1,
          `the queued send reached the subagent ${count(false, "done-queued")} times`,
        )
        expect(at("done-queued") > at("slow-busy"), "the queued send came before the busy task")
      })
      await step(4, "a report while the main agent is idle and mid-turn", async () => {
        await send(`report-idle: ${ask("idle")}`)
        await arrives("the report at the idle main agent", "rep-idle")
        await arrives("the reporting turn's result", "done-idle")
        await send(ask("hold"))
        await until("the main agent mid-turn", () => holding, 180_000)
        await send(`report-mid: ${ask("mid")}`)
        await arrives("the report sent while the main agent was mid-turn", "rep-mid")
        expect(reportedMidTurn === true, "the subagent reported after the main agent's turn had ended")
        await arrives("the mid-turn reporting turn's result", "done-mid")
      })
      await step(5, "a result after vibest daemon restart", async () => {
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: repo, env: c!.daemonEnv, timeoutMs: 60_000 })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        await send(ask("after"))
        await arrives("a result after vibestd restarted", "done-after")
      })
    } finally {
      model.stop()
      await c?.close()
    }
    const failed = outcomes.filter((o) => !o.endsWith("pass"))
    expect(failed.length === 0, failed.join("\n"))
  },
})

const checks: ReadonlyArray<Check> = [
  {
    id: "S11",
    title:
      "Claude main agent: a subagent's result arrives over HTTP as one line with its full text as prompt context, after /clear too, and after the main agent is stopped (SIGTERM) and `vibest` resumes it in the same pane",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // The main agent is a real Claude and its subagent a real Pi, both on the fake model.
      const model = fakeModel("pi")
      let c: Awaited<ReturnType<typeof claudeMain>> | undefined
      try {
        c = await claudeMain(w, "cmain", model)
        const title = "Answer the probe"
        const sub = await c.start(title, "cmone")
        await c.result(sub, title, "cmone", 0)
        const round = async (marker: string) => {
          const before = c!.delivered(sub)
          await w.ok(["send", sub, "--", ask(marker)], { cwd: c!.repo })
          await c!.result(sub, title, marker, before)
        }

        // /clear starts a new Claude conversation in the same process; the poll goes on and names the new one.
        const first = c.conversation()
        await Bun.sleep(10_000)
        await c.typeIn("/clear")
        await until("the conversation after /clear", () => c!.conversation() !== first, 60_000)
        await round("cmtwo")

        // The harness stopped from outside, then `vibest` again in its pane: the same conversation, resumed.
        const cleared = c.conversation()
        await Bun.sleep(10_000)
        const pid = await c.claude()
        expect(pid !== undefined, "no claude process in the main agent's pane")
        process.kill(pid!, "SIGTERM")
        await until("the main agent's Claude exited", async () => (await c!.claude()) === undefined, 30_000)
        await c.typeIn("vibest")
        await until("Claude again in the main agent's pane", async () => (await c!.claude()) !== undefined, 60_000)
        await round("cmthree")
        expect(c.conversation() === cleared, `resumed conversation ${c.conversation()}; before the stop ${cleared}`)
      } finally {
        model.stop()
        await c?.close()
      }
    },
  },
  {
    id: "S15",
    title:
      "Claude main agent over HTTP: two subagents' lines and contexts match one to one, a result arriving mid-turn still arrives, a lease goes back to pending once its poller leaves, curl --unix-socket poll / ack / project and protocol mismatch, and delivery after `vibest daemon restart`",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude", "curl"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = fakeModel("pi")
      let c: Awaited<ReturnType<typeof claudeMain>> | undefined
      let stopped: number | undefined
      try {
        c = await claudeMain(w, "cmtwo", model)
        // Two subagents, one after the other: each line goes with its own full text, never the other's.
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
          const line = `General Agent "${title}" completed (${sub})`
          const n = entries.filter((e) => e.type === "user" && e.text.includes(line)).length
          expect(n === 1, `the line for ${sub} shows ${n} times`)
        }

        // Mid-turn: the main agent is busy in a turn of its own when the result comes; it still arrives.
        await c.typeIn("Run the shell command `sleep 40` with the Bash tool, then reply with one word: slept")
        await until(
          "the main agent's own turn running",
          async () =>
            (await transcript(c!.config, c!.repo)).some((e) => e.type === "assistant" && e.raw.includes("sleep 40")),
          60_000,
        )
        const before = c.delivered(a)
        await w.ok(["send", a, "--", ask("cmmid")], { cwd: c.repo })
        await c.result(a, "Answer probe alpha", "cmmid", before)

        // curl --unix-socket, as the plugin: with the plugin stopped, a curl poll takes the row and leases it; nobody
        // acks, the poller is gone, and the row is pending again about 5 s later. A curl ack then delivers it.
        stopped = await c.claude()
        expect(stopped !== undefined, "no claude process in the main agent's pane")
        process.kill(stopped!, "SIGSTOP")
        await Bun.sleep(3_000)
        const who = { main: c.main, projectId: c.projectId }
        const status = (id: number) =>
          row<{ s: string }>(w, "SELECT delivery_status AS s FROM inbox WHERE id = ?", id)?.s
        await w.ok(["send", a, "--", ask("cmcurl")], { cwd: c.repo })
        let polled: { ids: Array<number>; line: string; text: string } = { ids: [], line: "", text: "" }
        await until(
          "a curl poll hands the result out",
          async () => {
            const r = await curl(w, "/inbox/poll", who)
            expect(r.status === 200, `poll answered ${r.status}: ${JSON.stringify(r.body)}`)
            polled = r.body as typeof polled
            return polled.ids.length > 0
          },
          180_000,
        )
        expect(polled.text.includes("done-cmcurl"), `the polled text: ${polled.text}`)
        const id = polled.ids[0]!
        expect(status(id) === "delivering", `after the poll the row is ${status(id)}`)
        await until("the lease back to pending once its poller left", () => status(id) === "pending", 15_000)
        const again = await curl(w, "/inbox/poll", who)
        expect(JSON.stringify((again.body as typeof polled).ids) === JSON.stringify(polled.ids), "polled again")
        const acked = await curl(w, "/inbox/ack", who, { ids: polled.ids })
        expect(
          acked.status === 200 && JSON.stringify(acked.body) === JSON.stringify({ acked: polled.ids }),
          `ack answered ${acked.status}: ${JSON.stringify(acked.body)}`,
        )
        expect(status(id) === "delivered", `after the ack the row is ${status(id)}`)
        const other = await curl(w, "/inbox/poll", { ...who, projectId: 999_999 })
        expect(other.status === 403, `another project's poll answered ${other.status}`)
        const old = await curl(w, "/inbox/poll", { ...who, protocol: "3" })
        expect(
          old.status === 409 && (old.body as { action?: string }).action === "vibest update",
          `an older protocol's poll answered ${old.status}: ${JSON.stringify(old.body)}`,
        )
        process.kill(stopped!, "SIGCONT")
        stopped = undefined

        // `vibest daemon restart` midway: the plugin polls the next vibestd, and the next result arrives.
        const restart = await w.tty(["daemon", "restart"], "y\n", {
          cwd: c.repo,
          env: c.daemonEnv,
          timeoutMs: 60_000,
        })
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
    title:
      "Pi main agent: each result reaches the real Pi TUI as its own turn: a Claude subagent's first and second result, and one after `vibest daemon restart`",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = fakeModel("claude")
      let c: Awaited<ReturnType<typeof claudeMain>> | undefined
      try {
        // A project of its own, so its main agent is this check's, not another check's. The Claude subagent's pane gets
        // the environment of the herdr server, which gets vibestd's: claudeMain starts both, Claude on the fake model.
        c = await claudeMain(w, "inbox", model, "pi")
        const { repo, env } = c
        const reached = (what: string, marker: string) =>
          until(what, () => model.seen.some((m) => m.includes("<agent-") && m.includes(marker)), 180_000).catch(
            (e: Error) => {
              throw new Error(`${e.message}; the main agent's model saw: ${JSON.stringify(model.seen, null, 1)}`)
            },
          )
        // The first result starts the main agent's turn: it runs the Claude subagent, and sends to it once it answers.
        await w.ok(["run", "pi", "--env", env, ask("zero")], { cwd: repo, timeoutMs: 60_000 })
        await reached("the main agent's turn on the first result", "done-zero")
        await reached("the main agent's turn on the Claude subagent's first result", "done-one")
        await reached("the main agent's turn on the Claude subagent's second result", "done-two")
        // `vibest daemon restart` ends the subscription on vibestd's side; the main agent subscribes to the next one.
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: repo, env: c.daemonEnv, timeoutMs: 60_000 })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        await w.ok(["send", model.sessionId(), ask("three")], { cwd: repo })
        await reached("the main agent's turn on a result after vibestd restarted", "done-three")
      } finally {
        model.stop()
        await c?.close()
      }
    },
  },
  ...(["claude", "pi"] as const).flatMap((main) => (["claude", "pi"] as const).map((sub) => matrix(main, sub))),
]

export default checks
