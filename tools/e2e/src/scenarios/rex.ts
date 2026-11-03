// The Rex runtime (feature-map S16): with `"runtime": "rex"` in vibest.json, the main agent and its subagents run in
// Rex blocks, and a Pi subagent's result reaches the Pi main agent as a turn. Rex is an isolated server of this check's
// own (its own socket, state and runtime directories, an empty config), never the user's; vibestd reaches it through
// REX_SERVER. Both agents' model is a fake OpenAI-compatible endpoint served here, as in S12.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, Skip, until } from "../world.ts"

/** `rex` as the runtime finds it (packages/runtime-rex `findRex`): PATH, else the CLI in the macOS app bundle. */
const findRex = () =>
  Bun.which("rex") ??
  ["Rex", "Rex Beta"]
    .map((app) => `/Applications/${app}.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`)
    .find((file) => Bun.spawnSync(["test", "-x", file]).exitCode === 0)

type Entry = { id: string; agent: string; runtime?: string }
type Message = { role: string; content: unknown }

const text = (m: Message | undefined) =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`

/** A task gets its two lines; the main agent's turn on the first result runs `vibest run pi` for the second task. */
const fakeModel = () => {
  const seen: Array<string> = []
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
                id: "call1",
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
    if (last?.role === "tool") return reply("ok")
    if (body.includes("<agent-"))
      return body.includes("done-zero") ? bash(`vibest run pi -- '${ask("one")}'`) : reply("ok")
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
  return { seen, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "S16",
    title:
      "Rex runtime: the main agent and a Pi subagent it starts run in Rex blocks of an isolated Rex server, the result reaches the main agent, ls shows runtime rex",
    run: async (w) => {
      const rex = findRex()
      if (rex === undefined) throw new Skip("Rex is not installed")
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      const model = fakeModel()
      const dir = path.join(w.root, "rex")
      const server = `unix://${dir}/rex.sock`
      let rexServer: ReturnType<typeof Bun.spawn> | undefined
      try {
        const repo = path.join(w.root, "rexapp")
        await fs.mkdir(repo, { recursive: true })
        for (const argv of [
          ["git", "init", "-q", "-b", "main"],
          ["git", "commit", "-q", "--allow-empty", "-m", "init"],
        ]) {
          const r = await w.run(repo, argv)
          expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
        }
        const agentDir = path.join(w.root, "pi-rex")
        await fs.mkdir(agentDir, { recursive: true })
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              fake: {
                baseUrl: model.url,
                apiKey: "fake",
                api: "openai-completions",
                models: [{ id: "m", contextWindow: 100_000, maxTokens: 1000 }],
              },
            },
          }),
        )
        await fs.writeFile(
          path.join(agentDir, "settings.json"),
          JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }),
        )
        const zdotdir = path.join(w.root, "zdotdir")
        for (const d of [path.join(dir, "state"), zdotdir]) await fs.mkdir(d, { recursive: true })
        await fs.writeFile(path.join(dir, "init.lua"), "")
        // The server's environment is what its terminals get (through a login shell): this world's, with every Pi on
        // the fake model, REX_SERVER naming this server, and an empty ZDOTDIR so the user's zshrc does not put an
        // installed vibest first on PATH.
        const env = {
          REX_SERVER: server,
          REX_AUTOSTART: "0",
          REX_RUNTIME_DIR: path.join(dir, "run"),
          PI_CODING_AGENT_DIR: agentDir,
          ZDOTDIR: zdotdir,
        }
        rexServer = Bun.spawn(
          [
            rex,
            "server",
            "run",
            "--listen",
            server,
            "--state-dir",
            path.join(dir, "state"),
            "--config",
            path.join(dir, "init.lua"),
          ],
          { cwd: dir, env: w.env(env), stdout: "ignore", stderr: Bun.file(path.join(w.root, "rex-server.log")) },
        )
        // Every rex terminal of this run is on that server (the check reads its session list below).
        w.ownRuntimes.add("rex")
        await until(
          "the isolated Rex server",
          async () =>
            (await w.run(dir, [rex, "-S", server, "--autostart=false", "api", "call", "server.status"])).code === 0,
          10_000,
        )
        await fs.writeFile(path.join(w.vibestHome, "vibest.json"), JSON.stringify({ runtime: "rex" }))
        // vibestd anew, so it starts with REX_SERVER (agents of earlier checks keep running).
        await w.stopDaemon()
        const opts = { cwd: repo, env, timeoutMs: 60_000 }
        await w.ok(
          ["--harness", "pi", "--session", w.herdrSession, "--headless", "--env", `PI_CODING_AGENT_DIR=${agentDir}`],
          opts,
        )
        const ls = () => w.json<Array<Entry>>(["ls"], opts)
        await until("the main agent in vibest ls", async () => (await ls()).some((e) => e.agent === "main"), 60_000)
        const reached = (what: string, marker: string) =>
          until(what, () => model.seen.some((m) => m.includes("<agent-") && m.includes(marker)), 180_000).catch(
            (e: Error) => {
              throw new Error(`${e.message}; the main agent's model saw: ${JSON.stringify(model.seen, null, 1)}`)
            },
          )
        // The first result starts the main agent's turn, which runs a Pi subagent of its own; its result comes back.
        await w.ok(["run", "pi", "--session", w.herdrSession, ask("zero")], opts)
        await reached("the main agent's turn on the first result", "done-zero")
        await reached("the main agent's turn on the result of the Pi subagent it started", "done-one")
        const rows = await w.json<Array<Entry>>(["ls", "--all"], opts)
        expect(rows.length >= 3, `vibest ls --all shows ${rows.length} rows: ${JSON.stringify(rows)}`)
        expect(
          rows.every((r) => r.runtime === "rex"),
          `not every row runs in rex: ${JSON.stringify(rows.map((r) => [r.id, r.agent, r.runtime]))}`,
        )
        const listed = await w.run(dir, [rex, "-S", server, "--autostart=false", "api", "call", "session.list"])
        expect(listed.stdout.includes("vibest rexapp"), `no Rex session for the project: ${listed.stdout}`)
      } finally {
        model.stop()
        await w.stopDaemon()
        // Its blocks (the agents in them) end with the server.
        rexServer?.kill()
        await rexServer?.exited
      }
    },
  },
]

export default checks
