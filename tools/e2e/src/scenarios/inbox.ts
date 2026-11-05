// The Claude main agent's inbox over HTTP (feature-map S11, S15) and the Pi main agent's (S12). Pi: every result reaches
// the real Pi TUI coordinator as a turn of its own, the
// later ones included. The main agent's model is a fake OpenAI-compatible endpoint served here (models.json in a
// PI_CODING_AGENT_DIR of this check) that drives it as the delegate skill does: `vibest run`, then `vibest send` on
// the result. vibestd, herdr, Pi and the subagent's harness are the real ones.
// S18: a Pi subagent on a model that holds its first turn past herdr's agent.start window keeps its terminal.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { agentModel, agentName, expect, herdr, row, SESSIONS, Skip, transcript, until, type World } from "../world.ts"

type Entry = { id: string; agent: string }
type Message = { role: string; content: unknown }

const text = (m: Message | undefined) =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`

/**
 * The main agent's model, and a Pi subagent's. A turn answers the last message: a task with its two lines; the
 * first result with `vibest run <sub>`; that subagent's first result with `vibest send`; anything else with "ok".
 * `seen` holds the last message of every request.
 */
const fakeModel = (sub: string) => {
  const seen: Array<string> = []
  let sessionId = ""
  let calls = 0
  const chunk = (o: object) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
  const done = (finish: string) =>
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) + "data: [DONE]\n\n"
  const reply = (content: string) =>
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + done("stop")
  const bash = (command: string) =>
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call${++calls}`,
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) + done("tool_calls")
  const answer = (last: Message | undefined) => {
    const body = text(last)
    if (last?.role === "tool") {
      // Session ids are UUIDs; \w stops at the first hyphen, and send then has no id.
      const id = /"id":\s*\\?"([\w-]+)\\?"/.exec(body)?.[1]
      if (id && !sessionId) sessionId = id
      return reply("ok")
    }
    if (body.includes("<agent-")) {
      if (body.includes("done-zero")) return bash(`vibest run ${sub} -- '${ask("one")}'`)
      if (body.includes("done-one")) return bash(`vibest send ${sessionId} -- '${ask("two")}'`)
      return reply("ok")
    }
    const task = /done-(\w+)/.exec(body)
    return task ? reply(`done-${task[1]}\nstatus: completed`) : reply("ok")
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      seen.push(`${messages.at(-1)?.role}: ${text(messages.at(-1))}`)
      return new Response(answer(messages.at(-1)), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { seen, sessionId: () => sessionId, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

/**
 * A model that holds a task's turn open (S18): its stream starts and then waits for `release`, which answers the task's
 * two lines. Anything else (the main agent's turn on the result) gets "ok".
 */
export const heldModel = () => {
  const held: Array<() => void> = []
  let released = false
  const chunk = (o: object) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
  const reply = (content: string) =>
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) +
    "data: [DONE]\n\n"
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const last = text(messages.at(-1))
      const headers = { "content-type": "text/event-stream" }
      const task = last.includes("<agent-") ? null : /done-(\w+)/.exec(last)
      if (!task) return new Response(reply("ok"), { headers })
      const answer = reply(`done-${task[1]}\nstatus: completed`)
      if (released) return new Response(answer, { headers })
      return new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(chunk({ choices: [{ index: 0, delta: { role: "assistant" } }] })))
            held.push(() => {
              try {
                c.enqueue(new TextEncoder().encode(answer))
                c.close()
              } catch {}
            })
          },
        }),
        { headers },
      )
    },
  })
  return {
    held: () => held.length,
    /** Answer one held turn and keep holding the next. `release` answers every held turn and stops holding. */
    releaseOne: () => {
      held.shift()?.()
    },
    release: () => {
      released = true
      for (const go of held.splice(0)) go()
    },
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      for (const go of held.splice(0)) go()
      server.stop(true)
    },
  }
}

/** A git repository of its own under the world's root: a project of its own, so its main agent is this check's. */
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

/** A PI_CODING_AGENT_DIR whose only model is the fake one at `url`. */
export const piDir = async (w: World, name: string, url: string) => {
  const dir = path.join(w.root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: url,
          apiKey: "fake",
          api: "openai-completions",
          models: [{ id: "m", contextWindow: 100_000, maxTokens: 1000 }],
        },
      },
    }),
  )
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }))
  return dir
}

/** Stops and deletes a herdr session this check started, as World.close does for the run's own. */
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

/**
 * A real Claude main agent (the user's login, on the E2E model: agentModel) in a herdr session of its own, for project
 * `name`, trusted and polling; its subagents are Pis on the fake `model`. `close` drops the session.
 */
const claudeMain = async (w: World, name: string, model: ReturnType<typeof fakeModel>) => {
  const session = `${w.herdrSession}-${name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const repo = await project(w, name)
  const env = `PI_CODING_AGENT_DIR=${await piDir(w, `pi-${name}`, model.url)}`
  // Panes get the herdr server's environment, which gets vibestd's: both start here, vibestd without
  // CLAUDE_CONFIG_DIR (the user's Claude login) and with an empty ZDOTDIR (the pane shell keeps this build first).
  const zdot = path.join(w.root, `zdotdir-${name}`)
  await fs.mkdir(zdot, { recursive: true })
  await w.stopDaemon()
  await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined, ZDOTDIR: zdot } })
  await w.ok(["--harness", "claude", ...agentModel(), "--session", session, "--headless"], {
    cwd: repo,
    timeoutMs: 120_000,
    env: { CLAUDE_CONFIG_DIR: undefined },
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
    row<{ c: string | null }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, main)?.c ?? null
  const pane = () => {
    const runtime = row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, main)?.r ?? "{}"
    const id = (JSON.parse(runtime) as { id?: string }).id ?? ""
    return id.split("/")[1] ?? ""
  }
  const screen = async () => {
    const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })
    return String((r.read as { text?: string } | undefined)?.text ?? "")
  }
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
  const delivered = (from: string) =>
    row<{ n: number }>(
      w,
      "SELECT count(*) AS n FROM inbox WHERE recipient_session_id = ? AND sender_session_id = ? AND status = 'delivered'",
      main,
      from,
    )?.n ?? 0
  /** The subagent's line shown as a user entry, and its full text attached as hook context. */
  const shown = async (line: string, marker: string) => {
    let entries: Awaited<ReturnType<typeof transcript>> = []
    await until(
      `the ${marker} line and its context in the main agent's conversation`,
      async () => {
        entries = await transcript(w, repo)
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
    ).catch(async (e: Error) => {
      const tail = entries.slice(-8).map((x) => `${x.type}: ${x.raw.slice(0, 300)}`)
      throw new Error(`${e.message}; the conversation ends with:\n${tail.join("\n")}\nits screen:\n${await screen()}`)
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
    // The line names the subagent by the first 8 characters of its id.
    return shown(`General Agent "${title}" completed (${sub.slice(0, 8)})`, marker)
  }
  const enter = () => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })
  const typeIn = async (text: string) => {
    await herdr(socket, "pane.send_text", { pane_id: pane(), text })
    await enter()
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
    main,
    projectId,
    conversation,
    delivered,
    start,
    result,
    typeIn,
    enter,
    claude,
    screen,
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
    "vibest-protocol": who.protocol ?? "5",
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

const checks: ReadonlyArray<Check> = [
  {
    id: "S11",
    title:
      "Claude main agent: a subagent's result arrives over HTTP as one line with its full text as prompt context, after /clear too, and after the main agent is stopped (SIGTERM) and `vibest` resumes it in the same pane",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // The subagent is a Pi on a fake model (cheap, its answers fixed); the main agent is a real Claude.
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
        await c.typeIn(["vibest", ...agentModel()].join(" "))
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
          const line = `General Agent "${title}" completed (${sub.slice(0, 8)})`
          const n = entries.filter((e) => e.type === "user" && e.text.includes(line)).length
          expect(n === 1, `the line for ${sub} shows ${n} times`)
        }

        // Mid-turn: the main agent is busy in a turn of its own when the result comes; it still arrives. Claude refuses a
        // standalone `sleep`, so the turn waits in a Bash call for a file this check creates once the result is in.
        const go = path.join(w.root, "cmmid-go")
        const wait = `until [ -e ${go} ]; do sleep 1; done`
        await c.typeIn(
          `Run this exact command with the Bash tool in the foreground, not in the background, and wait for it: ${wait} Then reply with one word: waited`,
        )
        let typed = Date.now()
        await until(
          "the main agent's own turn running",
          async () => {
            const entries = await transcript(w, c!.repo)
            if (entries.some((e) => e.type === "assistant" && e.raw.includes(go))) return true
            // The enter typed right behind the text is sometimes swallowed and the text stays in the input box: again.
            if (!entries.some((e) => e.type === "user" && e.text.includes(wait)) && Date.now() - typed > 5_000) {
              await c!.enter()
              typed = Date.now()
            }
            return false
          },
          60_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; its screen:\n${await c!.screen()}`)
        })
        const results = () =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM inbox WHERE recipient_session_id = ? AND sender_session_id = ?",
            c!.main,
            a,
          )?.n ?? 0
        const before = c.delivered(a)
        const queued = results()
        await w.ok(["send", a, "--", ask("cmmid")], { cwd: c.repo })
        await until("the cmmid result queued while the main agent's turn runs", () => results() > queued, 180_000)
        await fs.writeFile(go, "")
        await c.result(a, "Answer probe alpha", "cmmid", before)

        // curl --unix-socket, as the plugin: with the plugin stopped, a curl poll takes the row and leases it; nobody
        // acks, the poller is gone, and the row is pending again about 5 s later. A curl ack then delivers it.
        stopped = await c.claude()
        expect(stopped !== undefined, "no claude process in the main agent's pane")
        process.kill(stopped!, "SIGSTOP")
        await Bun.sleep(3_000)
        const who = { main: c.main, projectId: c.projectId }
        const status = (id: number) => row<{ s: string }>(w, "SELECT status AS s FROM inbox WHERE id = ?", id)?.s
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
        const other = await curl(w, "/inbox/poll", { ...who, projectId: "00000000-0000-4000-8000-000000000000" })
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
          env: { CLAUDE_CONFIG_DIR: undefined },
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
      const session = `${w.herdrSession}-inbox`
      try {
        // A project of its own, so its main agent is this check's (with the fake model), not another check's.
        const repo = await project(w, "inbox")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-inbox", model.url)}`
        // The Claude subagent runs with the user's own Claude login (CLAUDE_CONFIG_DIR unset), as I4's does. Its pane
        // gets the environment of the herdr server, which gets vibestd's, so this check starts both: vibestd anew (the one
        // before it stops; agents keep running) and a herdr session of its own.
        await w.stopDaemon()
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
          env: { CLAUDE_CONFIG_DIR: undefined },
        })
        const mains = async () => (await w.json<Array<Entry>>(["ls"], { cwd: repo })).filter((e) => e.agent === "main")
        await until("the main agent in vibest ls", async () => (await mains()).length === 1, 30_000)
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
        const restart = await w.tty(["daemon", "restart"], "y\n", {
          cwd: repo,
          env: { CLAUDE_CONFIG_DIR: undefined },
          timeoutMs: 60_000,
        })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        await w.ok(["send", model.sessionId(), ask("three")], { cwd: repo })
        await reached("the main agent's turn on a result after vibestd restarted", "done-three")
      } finally {
        model.stop()
        // As World.close does for the run's own session: only the one this check started.
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S18",
    title:
      "a Pi subagent whose first turn outlasts herdr's 120 s agent.start window keeps its terminal: herdr still names it s-<id>, vibest peek reads it, no exit is recorded, and its result arrives",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      const session = `${w.herdrSession}-held`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      try {
        const repo = await project(w, "held")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-held", model.url)}`
        const zdot = path.join(w.root, "zdotdir-held")
        await fs.mkdir(zdot, { recursive: true })
        await w.stopDaemon()
        await w.ok(["daemon"], { env: { ZDOTDIR: zdot } })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        const sub = (
          JSON.parse(
            await w.ok(["run", "pi", "--session", session, "--env", env, "--", ask("held")], {
              cwd: repo,
              timeoutMs: 60_000,
            }),
          ) as { id: string }
        ).id
        const started = Date.now()
        await until("the subagent's turn held by the model", () => model.held() > 0, 60_000)
        const named = async () =>
          ((await herdr(socket, "agent.list", {})).agents as Array<{ name?: string | null }>).some(
            (a) => a.name === agentName(sub),
          )
        const exited = () =>
          row<{ e: number | null }>(w, `SELECT exited_at AS e FROM ${SESSIONS} s WHERE id = ?`, sub)?.e ?? null
        // herdr drops a started agent's name when it is not marked ready within agent.start's timeout (120 s); vibestd then
        // finds no agent of this terminal and records the session as exited while its harness still works.
        while (Date.now() - started < 135_000) {
          await Bun.sleep(5_000)
          const log = async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")).slice(-3000)
          expect(exited() === null, `the subagent was recorded as exited at ${exited()}; vibestd.log:\n${await log()}`)
          expect(await named(), `herdr no longer names the subagent ${agentName(sub)}; vibestd.log:\n${await log()}`)
        }
        const peek = await w.vibest(["peek", sub], { cwd: repo })
        expect(peek.code === 0, `vibest peek ${sub} exited ${peek.code}: ${peek.stderr}${peek.stdout}`)
        model.release()
        await until(
          "the held turn's result",
          async () =>
            (
              (await w.json<{ result?: { message?: string } | null }>(["result", sub], { cwd: repo })).result
                ?.message ?? ""
            ).includes("done-held"),
          60_000,
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S20",
    title:
      "ids: vibest run answers a UUID, herdr names the agent s-<30 hex>, result takes 8 characters and peek 12, and the system prompt is $TMPDIR/vibest/<id>/system-prompt.md",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      model.release()
      const session = `${w.herdrSession}-ids`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      try {
        const repo = await project(w, "ids")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-ids", model.url)}`
        const zdot = path.join(w.root, "zdotdir-ids")
        await fs.mkdir(zdot, { recursive: true })
        await w.stopDaemon()
        await w.ok(["daemon"], { env: { ZDOTDIR: zdot } })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        const sub = (
          JSON.parse(
            await w.ok(["run", "pi", "--session", session, "--env", env, "--", ask("ids")], {
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
          "the result by its first 8 characters",
          async () =>
            (
              (await w.json<{ result?: { message?: string } | null }>(["result", sub.slice(0, 8)], { cwd: repo }))
                .result?.message ?? ""
            ).includes("done-ids"),
          60_000,
        )
        const peek = await w.vibest(["peek", sub.slice(0, 12)], { cwd: repo })
        expect(peek.code === 0, `vibest peek ${sub.slice(0, 12)} exited ${peek.code}: ${peek.stderr}${peek.stdout}`)
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
    title:
      "a Pi subagent with herdr's own Pi hook starts its first turn within seconds of vibest run: vibest daemon restart is not refused and vibest interrupt stops it while the model still holds the turn",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      const session = `${w.herdrSession}-confirm`
      try {
        const repo = await project(w, "confirm")
        const dir = await piDir(w, "pi-confirm", model.url)
        // herdr's Pi hook, as a user who ran `herdr integration install pi` has it: herdr then reads Pi's state from
        // the hook alone, and an idle Pi sends it nothing more.
        const hook = await w.run(w.root, ["herdr", "integration", "install", "pi"], {
          env: { PI_CODING_AGENT_DIR: dir },
        })
        expect(hook.code === 0, `herdr integration install pi exited ${hook.code}: ${hook.stderr}${hook.stdout}`)
        const env = `PI_CODING_AGENT_DIR=${dir}`
        const zdot = path.join(w.root, "zdotdir-confirm")
        await fs.mkdir(zdot, { recursive: true })
        await w.stopDaemon()
        await w.ok(["daemon"], { env: { ZDOTDIR: zdot } })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        const sub = (
          JSON.parse(
            await w.ok(["run", "pi", "--session", session, "--env", env, "--", ask("confirm")], {
              cwd: repo,
              timeoutMs: 60_000,
            }),
          ) as { id: string }
        ).id
        const log = async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")).slice(-3000)
        // herdr refuses agent.prompt until it marks the agent ready, and it marks one only when the agent is read.
        await until("the subagent's first turn at the model", () => model.held() > 0, 15_000)
        const t0 = Date.now()
        const restart = await w.tty(["daemon", "restart"], "y\n", {
          cwd: repo,
          env: { ZDOTDIR: zdot },
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
    title:
      "latency: 10 rounds of a busy Pi subagent, a queued send, then release, and 10 pane closes of idle subagents; records the times; the queued send goes out within 1500 ms (p95) of the turn end (the 5 s poll took about 5 s), and a closed pane's process ends within 1 s (p95)",
    run: async (w, evidence) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = heldModel()
      const session = `${w.herdrSession}-s26`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const zdot = path.join(w.root, "zdotdir-s26")
      await fs.mkdir(zdot, { recursive: true })
      const env = { ZDOTDIR: zdot }
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
        await w.stopDaemon()
        await w.ok(["daemon"], { env })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", pi], {
          cwd: repo,
          env,
          timeoutMs: 90_000,
        })
        const runSub = async (task: string) =>
          (
            JSON.parse(
              await w.ok(["run", "pi", "--session", session, "--env", pi, "--", ask(task)], {
                cwd: repo,
                env,
                timeoutMs: 90_000,
              }),
            ) as { id: string }
          ).id
        const sub = await runSub("busy")
        await until("the subagent's turn held", () => model.held() > 0, 60_000)
        const hook: Array<number> = []
        const delivery: Array<number> = []
        for (let i = 0; i < 10; i++) {
          const beforeEnd =
            q<{ id: number }>(
              "SELECT id FROM event WHERE session_id = ? AND type = 'turn.end' ORDER BY id DESC LIMIT 1",
              sub,
            )?.id ?? 0
          const beforeResult =
            q<{ id: number }>(
              `SELECT e.id AS id FROM event e JOIN inbox i ON i.id = e.inbox_id
                WHERE i.sender_session_id = ? AND i.kind = 'result' AND e.type = 'inbox.queued'
                ORDER BY e.id DESC LIMIT 1`,
              sub,
            )?.id ?? 0
          const message = ask(`r${i}`)
          await w.ok(["send", sub, "--", message], { cwd: repo, env })
          await until(
            `round ${i} queued`,
            () =>
              q<{ status: string }>(
                "SELECT status FROM inbox WHERE recipient_session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
                sub,
                message,
              )?.status === "pending",
            15_000,
          )
          const sent = q<{ id: number }>(
            "SELECT id FROM inbox WHERE recipient_session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
            sub,
            message,
          )
          expect(sent !== undefined, `round ${i}: the queued send is not in the database`)
          const logAt = (await fs.readFile(logFile, "utf8").catch(() => "")).length
          // Pi can open more than one stream for one turn. Release the ones held now, before the next turn exists.
          const open = model.held()
          expect(open >= 1, `round ${i}: no held turn`)
          for (let k = 0; k < open; k++) model.releaseOne()
          let receipt = 0
          let hookMs = 0
          let deliveryMs = 0
          await until(
            `round ${i} settled`,
            async () => {
              if (receipt === 0) {
                const fresh = (await fs.readFile(logFile, "utf8").catch(() => "")).slice(logAt)
                const line = fresh.split("\n").find((l) => l.includes(`turn end ${sub}`))
                const ts = line === undefined ? undefined : /timestamp=(\S+)/.exec(line)?.[1]
                const parsed = ts === undefined ? Number.NaN : Date.parse(ts)
                // A line with no timestamp (not logfmt): the poll time, a few milliseconds late.
                if (Number.isFinite(parsed)) receipt = parsed
                else if (line !== undefined) receipt = Date.now()
              }
              const end = q<{ at: number }>(
                "SELECT at FROM event WHERE session_id = ? AND type = 'turn.end' AND id > ? ORDER BY id LIMIT 1",
                sub,
                beforeEnd,
              )
              const result = q<{ at: number }>(
                `SELECT e.at AS at FROM event e JOIN inbox i ON i.id = e.inbox_id
                WHERE i.sender_session_id = ? AND i.kind = 'result' AND e.type = 'inbox.queued' AND e.id > ?
                ORDER BY e.id LIMIT 1`,
                sub,
                beforeResult,
              )
              const delivered = q<{ at: number }>(
                "SELECT at FROM event WHERE inbox_id = ? AND type = 'inbox.status' AND json_extract(data, '$.to') = 'delivering' ORDER BY id LIMIT 1",
                sent!.id,
              )
              if (
                !Number.isFinite(receipt) ||
                receipt === 0 ||
                end === undefined ||
                result === undefined ||
                delivered === undefined
              )
                return false
              hookMs = result.at - receipt
              deliveryMs = delivered.at - end.at
              return true
            },
            20_000,
          )
          hook.push(hookMs)
          delivery.push(deliveryMs)
          await until("the next turn held", () => model.held() > 0, 30_000)
        }
        model.release()
        const closes: Array<number> = []
        for (let i = 0; i < 10; i++) {
          const id = await runSub(`c${i}`)
          await until(
            `subagent ${i} idle`,
            () => {
              const open = q<{ id: number }>(
                `SELECT t.id AS id FROM event t WHERE t.session_id = ? AND t.type = 'turn.start'
                  AND NOT EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end')`,
                id,
              )
              const ended = q<{ id: number }>(
                "SELECT id FROM event WHERE session_id = ? AND type = 'turn.end' LIMIT 1",
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
                "SELECT at FROM event WHERE session_id = ? AND type = 'process.end' ORDER BY id DESC LIMIT 1",
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
          hookReceiptToResultMs: stats(hook),
          turnEndToDeliveringMs: stats(delivery),
          paneCloseToProcessEndMs: stats(closes),
        }
        await fs.writeFile(path.join(evidence, "latency.json"), `${JSON.stringify(out, null, 2)}\n`)
        console.log(`S26 ${JSON.stringify(out)}`)
        // A turn end delivers what was queued (the bus's turn.end handler), not the next 5 s poll.
        expect(
          out.turnEndToDeliveringMs.p95 <= 1500,
          `turn end to next delivering p95 is ${out.turnEndToDeliveringMs.p95} ms (at most 1500)`,
        )
        // An exit is the runtime's push, not the next 5 s poll.
        expect(
          out.paneCloseToProcessEndMs.p95 <= 1000,
          `pane close to process.end p95 is ${out.paneCloseToProcessEndMs.p95} ms (at most 1000)`,
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default checks
