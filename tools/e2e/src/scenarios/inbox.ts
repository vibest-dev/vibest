// The Pi main agent's inbox (feature-map S12): every result reaches the real Pi TUI coordinator as a turn of its own, the
// later ones included. The main agent's model is a fake OpenAI-compatible endpoint served here (models.json in a
// PI_CODING_AGENT_DIR of this check) that drives it as the delegate skill does: `vibest run`, then `vibest send` on
// the result. vibestd, herdr, Pi and the subagent's harness are the real ones.
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "../check.ts"
import { expect, Skip, until } from "../world.ts"

type Entry = { id: string; agent: string }
type Message = { role: string; content: unknown }

const text = (m: Message | undefined) => (m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content))
const ask = (task: string) => `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`

/**
 * The main agent's model, and a Pi subagent's. A turn answers the last message: a task with its two lines; the
 * first result with `vibest run <sub>`; that subagent's first result with `vibest send`; anything else with "ok".
 * `seen` holds the last message of every request.
 */
const fakeModel = (sub: string) => {
  const seen: Array<string> = []
  let sessionId = ""
  let calls = 0
  const chunk = (o: object) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
  const done = (finish: string) => chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "data: [DONE]\n\n"
  const reply = (content: string) => chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + done("stop")
  const bash = (command: string) =>
    chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call${++calls}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] }) +
    done("tool_calls")
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

const checks: ReadonlyArray<Check> = [
  {
    id: "S12",
    title: "Pi main agent: each result reaches the real Pi TUI as its own turn: a Claude subagent's first and second result, and one after `vibest daemon restart`",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = fakeModel("claude")
      const session = `${w.herdrSession}-inbox`
      try {
        // A project of its own, so its main agent is this check's (with the fake model), not another check's.
        const repo = path.join(w.root, "inbox")
        await fs.mkdir(repo, { recursive: true })
        for (const argv of [["git", "init", "-q", "-b", "main"], ["git", "commit", "-q", "--allow-empty", "-m", "init"]]) {
          const r = await w.run(repo, argv)
          expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
        }
        const agentDir = path.join(w.root, "pi-inbox")
        await fs.mkdir(agentDir, { recursive: true })
        await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: model.url, apiKey: "fake", api: "openai-completions", models: [{ id: "m", contextWindow: 100_000, maxTokens: 1000 }] } } }))
        await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }))
        const env = `PI_CODING_AGENT_DIR=${agentDir}`
        // The Claude subagent runs with the user's own Claude login (CLAUDE_CONFIG_DIR unset), as I4's does. Its pane
        // gets the environment of the herdr server, which gets vibestd's, so this check starts both: vibestd anew (the one
        // before it stops; agents keep running) and a herdr session of its own.
        await w.stopDaemon()
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], { cwd: repo, timeoutMs: 60_000, env: { CLAUDE_CONFIG_DIR: undefined } })
        const mains = async () => (await w.json<Array<Entry>>(["ls"], { cwd: repo })).filter((e) => e.agent === "main")
        await until("the main agent in vibest ls", async () => (await mains()).length === 1, 30_000)
        const reached = (what: string, marker: string) =>
          until(what, () => model.seen.some((m) => m.includes("<agent-") && m.includes(marker)), 180_000).catch((e: Error) => {
            throw new Error(`${e.message}; the main agent's model saw: ${JSON.stringify(model.seen, null, 1)}`)
          })
        // The first result starts the main agent's turn: it runs the Claude subagent, and sends to it once it answers.
        await w.ok(["run", "pi", "--env", env, ask("zero")], { cwd: repo, timeoutMs: 60_000 })
        await reached("the main agent's turn on the first result", "done-zero")
        await reached("the main agent's turn on the Claude subagent's first result", "done-one")
        await reached("the main agent's turn on the Claude subagent's second result", "done-two")
        // `vibest daemon restart` ends the subscription on vibestd's side; the main agent subscribes to the next one.
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: repo, env: { CLAUDE_CONFIG_DIR: undefined }, timeoutMs: 60_000 })
        expect(restart.code === 0, `daemon restart exited ${restart.code}: ${restart.stdout}${restart.stderr}`)
        await w.ok(["send", model.sessionId(), ask("three")], { cwd: repo })
        await reached("the main agent's turn on a result after vibestd restarted", "done-three")
      } finally {
        model.stop()
        // As World.close does for the run's own session: only the one this check started.
        if (await fs.stat(path.join(w.home, ".config", "herdr", "sessions", session)).then(() => true, () => false)) {
          await w.run(w.root, ["herdr", "session", "stop", session])
          await w.run(w.root, ["herdr", "session", "delete", session])
        }
      }
    },
  },
]

export default checks
