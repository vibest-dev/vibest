import { Database } from "bun:sqlite"
// The Pi main agent's inbox (feature-map S12): every result reaches the real Pi TUI coordinator as a turn of its own, the
// later ones included. The main agent's model is a fake OpenAI-compatible endpoint served here (models.json in a
// PI_CODING_AGENT_DIR of this check) that drives it as the delegate skill does: `vibest run`, then `vibest send` on
// the result. vibestd, herdr, Pi and the subagent's harness are the real ones.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, Skip, until, type World } from "../world.ts"

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
      const id = /"id":\s*\\?"(\w+)\\?"/.exec(body)?.[1]
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

/** A PI_CODING_AGENT_DIR whose only model is the fake one at `url`. */
const piDir = async (w: World, name: string, url: string) => {
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

/** One row of vibest.db, read while vibestd runs. */
const row = <A>(w: World, sql: string, ...args: Array<string | number>) => {
  const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
  try {
    return (db.query(sql).get(...args) ?? undefined) as A | undefined
  } finally {
    db.close()
  }
}

/** Every entry of the Claude conversations kept for `cwd` (the user's ~/.claude: CLAUDE_CONFIG_DIR is unset). */
const transcript = async (w: World, cwd: string) => {
  const dir = path.join(w.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
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

const checks: ReadonlyArray<Check> = [
  {
    id: "S11",
    title:
      "Claude main agent: a subagent's result arrives over HTTP as one line with its full text as prompt context, after /clear too, and after the main agent is stopped (SIGTERM) and `vibest` resumes it in the same pane",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // The subagent is a Pi on a fake model (cheap, its answers fixed); the main agent is a real Claude, the user's login.
      const model = fakeModel("pi")
      const session = `${w.herdrSession}-cmain`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      try {
        const repo = await project(w, "claude-main")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-claude-main", model.url)}`
        // Panes get the herdr server's environment, which gets vibestd's: both start here, vibestd without
        // CLAUDE_CONFIG_DIR (the user's Claude login) and with an empty ZDOTDIR (the pane shell keeps this build first).
        const zdot = path.join(w.root, "zdotdir-cmain")
        await fs.mkdir(zdot, { recursive: true })
        await w.stopDaemon()
        await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined, ZDOTDIR: zdot } })
        await w.ok(["--harness", "claude", "--model", "haiku", "--session", session, "--headless"], {
          cwd: repo,
          timeoutMs: 120_000,
          env: { CLAUDE_CONFIG_DIR: undefined },
        })
        type Entry = { id: string; agent: string }
        let main = ""
        await until(
          "the main agent in vibest ls",
          async () => {
            main = (await w.json<Array<Entry>>(["ls"], { cwd: repo })).find((e) => e.agent === "main")?.id ?? ""
            return main !== ""
          },
          60_000,
        )
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
          const runtime = row<{ r: string }>(w, "SELECT runtime AS r FROM session WHERE id = ?", main)?.r ?? "{}"
          const at = ((JSON.parse(runtime) as { id?: string }).id ?? "").split("/")[1] ?? ""
          const read = await herdr(socket, "pane.read", { pane_id: at, source: "visible", strip_ansi: true }).catch(
            (x: Error) => ({ error: x.message }),
          )
          const screen = `${runtime}\n${peek.stdout}${peek.stderr}\n${JSON.stringify(read).slice(0, 3000)}`
          const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
          throw new Error(`${e.message}; its screen:\n${screen}\nvibestd.log:\n${log.slice(-3000)}`)
        })
        const delivered = (from: string) =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM inbox WHERE recipient_session_id = ? AND sender_id = ? AND delivery_status = 'delivered'",
            main,
            from,
          )?.n ?? 0

        let sub = ""
        const title = "Answer the probe"
        /** One result from the subagent reaches the main agent: its line as the prompt, its full text as context. */
        const round = async (marker: string) => {
          const before = sub === "" ? 0 : delivered(sub)
          if (sub === "") {
            const run = await w.ok(["run", "pi", "--env", env, "--title", title, "--", ask(marker)], {
              cwd: repo,
              timeoutMs: 60_000,
            })
            sub = (JSON.parse(run) as { id: string }).id
          } else await w.ok(["send", sub, "--", ask(marker)], { cwd: repo })
          await until(`the ${marker} result delivered`, () => delivered(sub) > before, 180_000)
          const line = `General Agent "${title}" completed (${sub})`
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
                    e.type === "attachment" &&
                    e.raw.includes("hook_additional_context") &&
                    e.raw.includes(`done-${marker}`),
                )
              )
            },
            60_000,
          ).catch((e: Error) => {
            const tail = entries.slice(-8).map((x) => `${x.type}: ${x.raw.slice(0, 300)}`)
            throw new Error(`${e.message}; the conversation ends with:\n${tail.join("\n")}`)
          })
        }
        const typeIn = async (text: string) => {
          await herdr(socket, "pane.send_text", { pane_id: pane(), text })
          await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })
        }

        await round("cmone")

        // /clear starts a new Claude conversation in the same process; the poll goes on and names the new one.
        const first = conversation()
        await Bun.sleep(10_000)
        await typeIn("/clear")
        await until("the conversation after /clear", () => conversation() !== first, 60_000)
        await round("cmtwo")

        // The harness stopped from outside, then `vibest` again in its pane: the same conversation, resumed.
        const cleared = conversation()
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
        await Bun.sleep(10_000)
        const pid = await claude()
        expect(pid !== undefined, "no claude process in the main agent's pane")
        process.kill(pid!, "SIGTERM")
        await until("the main agent's Claude exited", async () => (await claude()) === undefined, 30_000)
        await typeIn("vibest --model haiku")
        await until("Claude again in the main agent's pane", async () => (await claude()) !== undefined, 60_000)
        await round("cmthree")
        expect(conversation() === cleared, `resumed conversation ${conversation()}; before the stop ${cleared}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
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
]

export default checks
