// `vibest update` restarts agents that run an old integration in place (plan: vibest update restarts old agents). The
// vibest on PATH is a wrapper that first runs an "old" install, a copy of the build whose integrations report another
// version; the update points it at the build, as an install does, and `vibest update` runs: vibestd hands itself over and
// restarts each old agent in place, subagents first: SIGTERM to the harness alone, then the runtime runs it again in the
// same terminal's shell (a main agent through `vibest integration start <id>`), and a main agent that was working gets
// the continue notice in its inbox. U2: a Pi main agent and Pi subagents on a fake OpenAI-compatible model served here,
// the update run by the person. U4: a real Claude main agent (agentModel) that runs the update itself. U5: a usage-limit
// move takes the same path. U7: a Claude main agent on a fake Anthropic model runs the update itself and is not
// restarted: vibestd syncs the plugin directory it loads, and Claude reloads the module after that turn. U4's old Claude
// plugin is patched to look like one from before reloads (its ready report names no directory), so it is restarted.
// vibestd, herdr and the harnesses are the real ones. ZDOTDIR is empty, so a pane's shell does
// not put another vibest first on PATH.
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { agentModel, alive, binary, expect, harnesses, herdr, Skip, transcript, until, type World } from "../world.ts"

type Message = { role: string; content: unknown }
type Row = { id: string; harness_session_id: string | null; pid: number | null; version: string | null }
type Agent = { name?: string | null; pane_id: string; agent?: string | null }

const text = (m: Message | undefined) =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`
const OLD = "0.0.0-old"

/**
 * The model of the main agent and of its Pi subagents: a task gets its two lines; the main agent's turn on the result
 * "done-slow" is held open until `release` (the turn the update interrupts); anything else gets "ok". `seen` holds each
 * request's messages.
 */
const fakeModel = () => {
  const seen: Array<ReadonlyArray<string>> = []
  const held: Array<() => void> = []
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
      seen.push(messages.map((m) => `${m.role}: ${text(m)}`))
      const last = text(messages.at(-1))
      const headers = { "content-type": "text/event-stream" }
      if (last.includes("<agent-") && last.includes("done-slow"))
        return new Response(
          new ReadableStream({
            start: (c) =>
              void held.push(() => {
                try {
                  c.close()
                } catch {}
              }),
          }),
          { headers },
        )
      const task = last.includes("<agent-") ? null : /done-(\w+)/.exec(last)
      return new Response(reply(task ? `done-${task[1]}\nstatus: completed` : "ok"), { headers })
    },
  })
  return {
    seen,
    held: () => held.length,
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      for (const release of held) release()
      server.stop(true)
    },
  }
}

/**
 * A fake Anthropic Messages API for a Claude main agent: `steps` answers each of the main agent's requests (those that
 * offer tools) from what came since its last answer, a Bash call or a text; anything else gets "ok". `seen` holds each main request's
 * messages as text. Streams when asked, as Claude Code asks.
 */
const fakeAnthropic = (
  steps: (last: string, toolResult: string | undefined) => { readonly bash: string; readonly id: string } | string,
) => {
  const seen: Array<ReadonlyArray<string>> = []
  let n = 0
  const sse = (events: ReadonlyArray<readonly [string, object]>) =>
    events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`).join("")
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method !== "POST" || !url.pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 })
      const body = (await req.json()) as {
        stream?: boolean
        tools?: Array<unknown>
        messages?: Array<{ role: string; content: unknown }>
      }
      const messages = body.messages ?? []
      // What came since the model's last answer: Claude Code may send its reminders as messages of their own.
      const since = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1)
      const blocks = since.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Array<{ type?: string; tool_use_id?: string }>) : [],
      )
      const result = blocks.find((b) => b.type === "tool_result")?.tool_use_id
      let content: Array<object> = [{ type: "text", text: "ok" }]
      let stop = "end_turn"
      if ((body.tools?.length ?? 0) > 0) {
        seen.push(messages.map((m) => `${m.role}: ${text(m)}`))
        const step = steps(since.map(text).join("\n"), result)
        if (typeof step === "string") content = [{ type: "text", text: step }]
        else {
          content = [{ type: "tool_use", id: step.id, name: "Bash", input: { command: step.bash, description: "run" } }]
          stop = "tool_use"
        }
      }
      const id = `msg_${++n}`
      const usage = { input_tokens: 1, output_tokens: 1 }
      const message = {
        id,
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content,
        stop_reason: stop,
        usage,
      }
      if (!body.stream) return Response.json(message)
      const events: Array<readonly [string, object]> = [
        ["message_start", { message: { ...message, content: [], stop_reason: null } }],
      ]
      content.forEach((c, index) => {
        const block = c as { type: string; text?: string; id?: string; name?: string; input?: object }
        if (block.type === "text") {
          events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }])
          events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }])
        } else {
          events.push([
            "content_block_start",
            { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
          ])
          events.push([
            "content_block_delta",
            { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
          ])
        }
        events.push(["content_block_stop", { index }])
      })
      events.push(["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }])
      events.push(["message_stop", {}])
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/**
 * A Claude config directory of its own for a fake model: the API key approved, onboarding done, `repo` trusted, and
 * auto mode off (its first-run questions would stop the pane). Its env for vibestd and the main agent.
 */
const claudeConfig = async (w: World, name: string, repo: string, url: string) => {
  const dir = path.join(w.root, `claude-${name}`)
  await fs.mkdir(dir, { recursive: true })
  const key = "sk-ant-e2e-fake-0123456789abcdefghijklmnop"
  await fs.writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [repo]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ disableAutoMode: "disable", permissions: { defaultMode: "default", disableAutoMode: "disable" } }),
  )
  return { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: key }
}

/** A git repository of its own under the world's root (a project of its own), as its real path. */
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

/**
 * An "old" install under the world's root: the build's binary beside harnesses whose integrations report OLD, and a
 * `vibest` wrapper (first on PATH in `env`) that `point` repoints, as an install does. ZDOTDIR is empty, so a pane's
 * shell does not put the user's own vibest first.
 */
const oldInstall = async (w: World, name: string, options: { readonly beforeReloads?: boolean } = {}) => {
  const old = path.join(w.root, `${name}-old`)
  await fs.mkdir(path.join(old, "bin"), { recursive: true })
  await fs.copyFile(binary, path.join(old, "bin", "vibest"))
  await fs.chmod(path.join(old, "bin", "vibest"), 0o755)
  await fs.cp(harnesses, path.join(old, "harnesses"), { recursive: true })
  const patch = async (file: string, from: RegExp, to: string) => {
    const source = await fs.readFile(file, "utf8")
    const patched = source.replace(from, to)
    expect(patched !== source, `${file}: its version was not found`)
    await fs.writeFile(file, patched)
  }
  await patch(
    path.join(old, "harnesses", "pi", "extension.mjs"),
    /var VERSION = package_default\.version;/,
    `var VERSION = "${OLD}";`,
  )
  await patch(
    path.join(old, "harnesses", "claude", "hooks", "register.mjs"),
    /pluginVersion: "[^"]+"/,
    `pluginVersion: "${OLD}"`,
  )
  // A Claude plugin from before reloads: its ready report does not say where it was loaded from, so vibestd restarts it.
  if (options.beforeReloads)
    await patch(
      path.join(old, "harnesses", "claude", "hooks", "register.mjs"),
      /plugin: host\.root\(\)/,
      "plugin: undefined",
    )
  const bin = path.join(w.root, `${name}-bin`)
  await fs.mkdir(bin, { recursive: true })
  const wrapper = path.join(bin, "vibest")
  const point = (target: string) => fs.writeFile(wrapper, `#!/bin/sh\nexec '${target}' "$@"\n`, { mode: 0o755 })
  await point(path.join(old, "bin", "vibest"))
  const zdotdir = path.join(w.root, `${name}-zdotdir`)
  await fs.mkdir(zdotdir, { recursive: true })
  return { wrapper, point, env: { PATH: `${bin}:${w.env().PATH}`, ZDOTDIR: zdotdir } }
}

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

const checks: ReadonlyArray<Check> = [
  {
    id: "U2",
    title:
      "vibest update: vibestd hands over; No keeps an old Pi main agent mid-turn (its old protocol is told to run vibest update), Yes restarts its Pi subagent (herdr lists it as s-<id> before and after) and then it in its pane on the same session and conversation, its inbox continues the turn, and results still arrive",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = fakeModel()
      const session = `${w.herdrSession}-restart`
      try {
        const repo = await project(w, "restart")
        const agentDir = path.join(w.root, "pi-restart")
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
        const { wrapper, point, env } = await oldInstall(w, "restart")
        const piEnv = `PI_CODING_AGENT_DIR=${agentDir}`
        const vibest = (args: ReadonlyArray<string>, timeoutMs = 60_000) =>
          w.run(repo, [wrapper, ...args], { env, timeoutMs })
        const ok = async (args: ReadonlyArray<string>, timeoutMs?: number) => {
          const r = await vibest(args, timeoutMs)
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
        const read = (where: string, arg: string) => {
          const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, json_extract(s.metadata, '$.pid') AS pid,
                   json_extract(s.metadata, '$.integration.version') AS version
                 FROM session s WHERE ${where}`,
              )
              .get(arg)
          } finally {
            db.close()
          }
        }
        const main = () =>
          read(
            `s.agent_type = 'main' AND s.ended_at IS NULL AND json_extract(s.metadata, '$.projectDirectory') LIKE ?`,
            `%/${path.basename(repo)}`,
          )
        const subRow = (id: string) => read("s.id = ?", id)
        // herdr's own list: a subagent's harness carries the name s-<id> that `open` gave it, and `run` again after a restart.
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        const listed = async (id: string) =>
          ((await herdr(socket, "agent.list", {})).agents as Array<Agent>).find((a) => a.name === `s-${id}`)
        const reached = (what: string, ok: (messages: ReadonlyArray<string>) => boolean) =>
          until(what, () => model.seen.some(ok), 120_000).catch(async (e: Error) => {
            const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
            throw new Error(
              `${e.message}; the model saw: ${JSON.stringify(
                model.seen.map((m) => m.at(-1)),
                null,
                1,
              )}\nvibestd.log:\n${log.slice(-4000)}`,
            )
          })
        const result = (marker: string) => (m: ReadonlyArray<string>) =>
          m.at(-1)!.includes("<agent-") && m.at(-1)!.includes(marker)

        // The old vibest starts vibestd and the main agent; the main agent's turn on a first result is history.
        await w.stopDaemon()
        await ok(["--harness", "pi", "--session", session, "--headless", "--env", piEnv])
        const zero = (
          JSON.parse(await ok(["run", "pi", "--session", session, "--env", piEnv, ask("zero")])) as { id: string }
        ).id
        await reached("the main agent's turn on the first result", result("done-zero"))
        await until("herdr lists the subagent as s-<id>", async () => (await listed(zero))?.agent === "pi", 60_000)
        const subPane = (await listed(zero))!.pane_id
        const subBefore = subRow(zero)!
        expect(subBefore.version === OLD && subBefore.pid !== null, `the subagent's row: ${JSON.stringify(subBefore)}`)
        // Pi reports its conversation at the end of its first turn.
        await until(
          "the main agent reports the old integration and its conversation",
          () => {
            const row = main()
            return row?.version === OLD && row.harness_session_id !== null && row.pid !== null
          },
          60_000,
        )
        const before = main()!
        const daemonBefore = await w.daemonPid()
        const address = async () =>
          (await w.json<Array<{ id: string; address: unknown }>>(["ls"], { cwd: repo, env })).find(
            (e) => e.id === before.id,
          )?.address
        const addressBefore = await address()
        // A result whose turn the model holds open: the main agent is working when the update comes.
        await ok(["run", "pi", "--session", session, "--env", piEnv, ask("slow")])
        await until("the main agent's held turn", () => model.held() > 0, 120_000)

        // The install: `vibest` on PATH is now the build. Then the rest of `vibest update`, answering No first.
        await point(binary)
        const update = async (answer: string) => {
          const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "update"]
          const r = await w.run(repo, pty, { env, stdin: `${answer}\n`, timeoutMs: 180_000 })
          const out = r.stdout.replace(/\r/g, "")
          expect(r.code === 0, `vibest update (${answer}) exited ${r.code}: ${out}${r.stderr}`)
          return out
        }
        const no = await update("n")
        expect(/vibestd: handoff\./.test(no), `vibestd was not handed over: ${no}`)
        expect(no.includes("They keep the old integration"), `No did not keep the agent: ${no}`)
        const daemonAfter = await w.daemonPid()
        expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
        expect(daemonBefore === undefined || !alive(daemonBefore), `the old vibestd ${daemonBefore} still runs`)
        const kept = main()
        expect(kept?.pid === before.pid && alive(before.pid!), `No restarted the main agent: ${JSON.stringify(kept)}`)
        expect(kept?.version === OLD, `the kept agent's integration: ${kept?.version}`)
        // A call in another protocol from that agent is refused with the step that fixes it.
        const refused = await fetch("http://vibestd/inbox/poll", {
          unix: path.join(w.vibestHome, "vibest-http.sock"),
          method: "POST",
          headers: { "vibest-protocol": "2", "vibest-session-id": before.id },
          body: "{}",
        } as RequestInit)
        const answer = (await refused.json()) as { error?: string; action?: string }
        expect(
          refused.status === 409 && answer.action === "vibest update" && /vibest update/.test(answer.error ?? ""),
          `an old protocol's call got ${refused.status} ${JSON.stringify(answer)}`,
        )

        // Yes: vibestd is current now; it restarts the agents once `vibest update` has exited, the subagent first.
        const yes = await update("y")
        expect(
          yes.includes("vibest update has finished") && yes.includes(before.id) && yes.includes(zero),
          `the agents were not handed to vibestd for a restart: ${yes}`,
        )
        expect((await w.daemonPid()) === daemonAfter, `vibestd changed again on the second update: ${yes}`)
        await until(
          "the subagent restarted on this integration",
          () => {
            const row = subRow(zero)
            return row?.pid != null && row.pid !== subBefore.pid && row.version !== OLD && row.version !== null
          },
          120_000,
        )
        expect(!alive(subBefore.pid!), `the subagent's old harness ${subBefore.pid} still runs`)
        expect(
          subRow(zero)?.harness_session_id === subBefore.harness_session_id,
          `the subagent's conversation changed: ${subBefore.harness_session_id} -> ${subRow(zero)?.harness_session_id}`,
        )
        await until(
          "herdr lists the restarted subagent as s-<id>",
          async () => (await listed(zero))?.agent === "pi",
          60_000,
        )
        expect((await listed(zero))?.pane_id === subPane, `the subagent's pane changed: ${subPane}`)
        // The signal clears the pid; the new harness reports its own.
        await until("the main agent restarted", () => main()?.pid != null && main()?.pid !== before.pid, 120_000)
        const after = main()
        expect(after?.id === before.id, `the main agent's session changed: ${before.id} -> ${after?.id}`)
        expect(
          after?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${after?.harness_session_id}`,
        )
        expect(after?.pid !== before.pid, `the harness pid did not change (${before.pid})`)
        expect(!alive(before.pid!), `the old harness ${before.pid} still runs`)
        await until("the restarted main agent reports this integration", () => main()?.version !== OLD, 30_000)
        expect(
          JSON.stringify(await address()) === JSON.stringify(addressBefore),
          `the main agent's terminal changed: ${JSON.stringify(addressBefore)} -> ${JSON.stringify(await address())}`,
        )
        // The interrupted turn continues on the same conversation: vibestd's notice reaches it through its inbox, and the
        // request carries the turns before the update.
        await reached(
          "the continue notice of the interrupted turn, with the earlier turns",
          (m) =>
            /^user: .*"text":"vibest update is done and restarted this agent; do not run it again, continue the interrupted work\./.test(
              m.at(-1)!,
            ) &&
            m.some((x) => x.includes("done-zero")) &&
            m.some((x) => x.includes("done-slow")),
        )
        // And results still reach the main agent, through the new vibestd.
        await ok(["run", "pi", "--session", session, "--env", piEnv, ask("after")])
        await reached("the main agent's turn on a result after the update", result("done-after"))
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U3",
    title:
      "vibest update: a handoff the new vibest refuses before the takeover (a database it cannot open) leaves the old vibestd serving",
    run: async (w) => {
      // The old vibestd: the build under another path, so `vibest update` plans a handoff to the build.
      const old = path.join(w.root, "handoff-old", "bin", "vibest")
      await fs.mkdir(path.dirname(old), { recursive: true })
      await fs.copyFile(binary, old)
      await fs.chmod(old, 0o755)
      await w.stopDaemon()
      const started = await w.run(w.repository, [old, "daemon"])
      expect(started.code === 0, `old vibest daemon exited ${started.code}: ${started.stderr}`)
      const before = await w.daemonPid()
      expect(before !== undefined, "no vibestd pid")
      // A schema version the build does not know: its import check fails.
      const file = path.join(w.vibestHome, "vibest.db")
      const userVersion = (v?: number) => {
        const db = new Database(file)
        try {
          if (v !== undefined) db.run(`PRAGMA user_version = ${v}`)
          return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
        } finally {
          db.close()
        }
      }
      const schema = userVersion()
      userVersion(schema + 1)
      try {
        const r = await w.vibest(["update"], { timeoutMs: 120_000 })
        const out = `${r.stdout}${r.stderr}`
        expect(r.code !== 0, `vibest update exited 0: ${out}`)
        expect(/vibestd: handoff\./.test(out) && /old vibestd .* still runs/.test(out), `unexpected: ${out}`)
        expect((await w.daemonPid()) === before && alive(before!), `vibestd ${before} -> ${await w.daemonPid()}`)
        await w.ok(["ls"])
      } finally {
        userVersion(schema)
        await w.stopDaemon()
      }
    },
  },
  {
    id: "U6",
    title:
      "vibest daemon restart onto another vibest: Yes to both questions replaces vibestd and restarts an old Pi subagent in place, in the same pane on the same conversation",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = fakeModel()
      const session = `${w.herdrSession}-drestart`
      try {
        const repo = await project(w, "drestart")
        const agentDir = path.join(w.root, "pi-drestart")
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
        const { wrapper, point, env } = await oldInstall(w, "drestart")
        const ok = async (args: ReadonlyArray<string>) => {
          const r = await w.run(repo, [wrapper, ...args], { env, timeoutMs: 60_000 })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
        const row = (id: string) => {
          const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, json_extract(s.metadata, '$.pid') AS pid,
                   json_extract(s.metadata, '$.integration.version') AS version
                 FROM session s WHERE s.id = ?`,
              )
              .get(id)
          } finally {
            db.close()
          }
        }
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        const listed = async (id: string) =>
          ((await herdr(socket, "agent.list", {})).agents as Array<Agent>).find((a) => a.name === `s-${id}`)

        // The old vibest starts vibestd and a Pi subagent, which reports the old integration after its first turn.
        await w.stopDaemon()
        await ok(["daemon"])
        const id = (
          JSON.parse(
            await ok(["run", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, ask("one")]),
          ) as { id: string }
        ).id
        await until(
          "the subagent reports the old integration and its conversation",
          () => {
            const r = row(id)
            return r?.version === OLD && r.pid !== null && r.harness_session_id !== null
          },
          120_000,
        )
        const before = row(id)!
        const pane = (await listed(id))?.pane_id
        const daemonBefore = await w.daemonPid()

        // `vibest` on PATH is now the build; `vibest daemon restart` from it, Yes to the replacement and to the restart.
        await point(binary)
        const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "daemon", "restart"]
        const r = await w.run(repo, pty, { env, stdin: "y\ny\n", timeoutMs: 180_000 })
        const out = r.stdout.replace(/\r/g, "")
        expect(r.code === 0, `vibest daemon restart exited ${r.code}: ${out}${r.stderr}`)
        expect(
          /Restart (it|these \d+ agents) in place and continue (its conversation|their conversations)\? \[Y\/n\]/.test(
            out,
          ) &&
            out.includes("vibest daemon restart has finished") &&
            out.includes(id),
          `the subagent was not offered for a restart: ${out}`,
        )
        const daemonAfter = await w.daemonPid()
        expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
        await until(
          "the subagent restarted on this integration",
          () => {
            const now = row(id)
            return now?.pid != null && now.pid !== before.pid && now.version !== OLD && now.version !== null
          },
          120_000,
        )
        expect(!alive(before.pid!), `the subagent's old harness ${before.pid} still runs`)
        expect(
          row(id)?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${row(id)?.harness_session_id}`,
        )
        await until(
          "herdr lists the restarted subagent as s-<id>",
          async () => (await listed(id))?.agent === "pi",
          60_000,
        )
        expect((await listed(id))?.pane_id === pane, `the subagent's pane changed: ${pane}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U4",
    title:
      "vibest update run by a Claude main agent itself: the CLI hands the restart to vibestd and returns; vibestd restarts it in its pane on the same conversation, its inbox gets the continue notice, and it goes on without running vibest update again",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const session = `${w.herdrSession}-cupdate`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      try {
        const repo = await project(w, "claude-update")
        const install = await oldInstall(w, "cupdate", { beforeReloads: true })
        // vibestd and the herdr server it starts run without CLAUDE_CONFIG_DIR: the main agent is a real Claude on the
        // user's login, on the E2E model (agentModel).
        const env = { ...install.env, CLAUDE_CONFIG_DIR: undefined }
        const vibest = async (args: ReadonlyArray<string>, timeoutMs = 120_000) => {
          const r = await w.run(repo, [install.wrapper, ...args], { env, timeoutMs })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
        type Main = {
          id: string
          conversation: string | null
          runtime: string
          pid: number | null
          version: string | null
        }
        const main = () => {
          const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
          try {
            return (
              db
                .query<Main, [string]>(
                  `SELECT id, harness_session_id AS conversation, runtime, json_extract(metadata, '$.pid') AS pid,
                     json_extract(metadata, '$.integration.version') AS version
                   FROM session WHERE agent_type = 'main' AND ended_at IS NULL AND json_extract(metadata, '$.projectDirectory') = ?`,
                )
                .get(repo) ?? undefined
            )
          } finally {
            db.close()
          }
        }
        const pane = () => ((JSON.parse(main()?.runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1] ?? ""
        const screen = async () => {
          const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })
          return String((r.read as { text?: string } | undefined)?.text ?? "")
        }
        const log = async () =>
          (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000)

        await w.stopDaemon()
        await vibest(["daemon"])
        await vibest(["--harness", "claude", ...agentModel(), "--session", session, "--headless"])
        await until("the main agent's row", () => pane() !== "", 60_000)
        // A new folder: the person answers Claude's trust question for the main agent.
        await until(
          "Claude's trust question or its input box",
          async () => /trust this folder|❯\s*$/m.test(await screen()),
          60_000,
        )
        for (let i = 0; i < 10 && /trust this folder/.test(await screen()); i++) {
          const yes = /^\s*❯.*Yes, I trust this folder/m.test(await screen())
          await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: [yes ? "enter" : "down"] })
          await Bun.sleep(1_000)
        }
        // The plugin's first poll names its conversation and its old integration.
        await until(
          "the main agent polls on the old integration",
          () => main()?.version === OLD && main()?.conversation != null && main()?.pid != null,
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; row ${JSON.stringify(main())}; screen:\n${await screen()}\n${await log()}`)
        })
        const before = main()!

        // The install: `vibest` on PATH is now the build. The main agent runs the rest of the update itself.
        await install.point(binary)
        await Bun.sleep(5_000)
        await herdr(socket, "pane.send_text", {
          pane_id: pane(),
          text: "Run this shell command once: vibest update --yes   Then reply with the one word UPDATED.",
        })
        await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })

        await until(
          "the main agent restarted on this integration",
          () => {
            const row = main()
            return (
              row !== undefined &&
              row.pid != null &&
              row.pid !== before.pid &&
              row.version !== OLD &&
              row.version !== null
            )
          },
          240_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; row ${JSON.stringify(main())}; screen:\n${await screen()}\n${await log()}`)
        })
        expect(!alive(before.pid!), `the old Claude ${before.pid} still runs`)
        expect(main()?.id === before.id, `the main agent's session changed: ${before.id} -> ${main()?.id}`)
        expect(
          main()?.conversation === before.conversation,
          `the conversation changed: ${before.conversation} -> ${main()?.conversation}`,
        )
        expect(main()?.runtime === before.runtime, `the terminal changed: ${before.runtime} -> ${main()?.runtime}`)

        // The continue notice arrives as the line Claude acts on, and the turn it starts ends without another update.
        const updates = (entries: Awaited<ReturnType<typeof transcript>>) =>
          entries.filter((e) => e.type === "assistant" && /"name":"Bash"/.test(e.raw) && /vibest update/.test(e.raw))
            .length
        let entries: Awaited<ReturnType<typeof transcript>> = []
        await until(
          "the continue notice in the main agent's conversation, and a reply after it",
          async () => {
            entries = await transcript(w, repo)
            const at = entries.findIndex(
              (e) =>
                e.type === "user" &&
                e.text.includes(
                  "Notice: vibest update is done and restarted this agent; do not run it again, continue the interrupted work.",
                ),
            )
            return at !== -1 && entries.slice(at + 1).some((e) => e.type === "assistant" && e.text.trim() !== "")
          },
          180_000,
        ).catch(async (e: Error) => {
          const tail = entries.slice(-10).map((x) => `${x.type}: ${x.raw.slice(0, 300)}`)
          throw new Error(`${e.message}; the conversation ends with:\n${tail.join("\n")}\n${await log()}`)
        })
        await Bun.sleep(15_000)
        entries = await transcript(w, repo)
        expect(updates(entries) === 1, `vibest update ran ${updates(entries)} times in the main agent's conversation`)
        expect(main()?.pid !== null && alive(main()!.pid!), "the restarted main agent is not running")
      } finally {
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U7",
    title:
      "vibest update run by a Claude main agent on a fake model: no restart; its turn runs on across the handoff and the plugin sync (a tool in flight), the module reloads only after that turn on the same conversation and pid, and a result that arrives around the reload is shown once",
    run: async (w) => {
      for (const bin of ["herdr", "claude", "pi"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const session = `${w.herdrSession}-u7`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const pi = fakeModel()
      const repo = await project(w, "u7")
      const agentDir = path.join(w.root, "pi-u7")
      await fs.mkdir(agentDir, { recursive: true })
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              baseUrl: pi.url,
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
      type Main = {
        id: string
        conversation: string | null
        runtime: string
        pid: number | null
        version: string | null
      }
      const main = () => {
        const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
        try {
          return (
            db
              .query<Main, [string]>(
                `SELECT id, harness_session_id AS conversation, runtime, json_extract(metadata, '$.pid') AS pid,
                   json_extract(metadata, '$.integration.version') AS version
                 FROM session WHERE agent_type = 'main' AND ended_at IS NULL AND json_extract(metadata, '$.projectDirectory') = ?`,
              )
              .get(repo) ?? undefined
          )
        } finally {
          db.close()
        }
      }
      const inbox = (recipient: string) => {
        const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
        try {
          return db
            .query<{ status: string; sender: string | null }, [string]>(
              "SELECT delivery_status AS status, sender_id AS sender FROM inbox WHERE recipient_session_id = ?",
            )
            .all(recipient)
        } finally {
          db.close()
        }
      }
      // The main agent's one turn: the update, a Pi subagent, a tool still running while the result arrives, its end.
      const ran: Record<string, string> = {}
      let versionAtSleepResult: string | null | undefined
      let inboxAtTurnEnd: ReadonlyArray<{ status: string }> = []
      const claude = fakeAnthropic((last, result) => {
        if (result === "toolu_update") {
          ran.update = last
          return {
            id: "toolu_run",
            bash: `vibest run pi --session ${session} --env PI_CODING_AGENT_DIR=${agentDir} '${ask("u7")}'`,
          }
        }
        if (result === "toolu_run") {
          ran.run = last
          return { id: "toolu_sleep", bash: "sleep 15" }
        }
        if (result === "toolu_sleep") {
          ran.sleep = last
          // The turn has not ended yet: the module must not have reloaded.
          versionAtSleepResult = main()?.version
          inboxAtTurnEnd = main() === undefined ? [] : inbox(main()!.id)
          return "turn-done"
        }
        if (result === undefined && last.includes("u7-go") && ran.update === undefined)
          return { id: "toolu_update", bash: "vibest update --yes" }
        return "ok"
      })
      try {
        const install = await oldInstall(w, "u7")
        const env = { ...install.env, ...(await claudeConfig(w, "u7", repo, claude.url)) }
        const vibest = async (args: ReadonlyArray<string>, timeoutMs = 120_000) => {
          const r = await w.run(repo, [install.wrapper, ...args], { env, timeoutMs })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
        const pane = () => ((JSON.parse(main()?.runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1] ?? ""
        const screen = async () => {
          const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true }).catch(
            () => ({}) as Record<string, unknown>,
          )
          return String((r.read as { text?: string } | undefined)?.text ?? "")
        }
        const why = async (e: Error) => {
          const log = (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000)
          return new Error(
            `${e.message}; row ${JSON.stringify(main())}; steps ${JSON.stringify(Object.keys(ran))}; screen:\n${await screen()}\n${log}`,
          )
        }

        await w.stopDaemon()
        await vibest(["daemon"])
        await vibest(["--harness", "claude", "--session", session, "--headless"])
        await until("the main agent's row", () => pane() !== "", 60_000)
        await until(
          "the main agent polls on the old integration",
          () => main()?.version === OLD && main()?.conversation != null && main()?.pid != null,
          120_000,
        ).catch(async (e: Error) => {
          throw await why(e)
        })
        const before = main()!

        // The install: `vibest` on PATH is now the build. The main agent runs the rest of the update itself.
        await install.point(binary)
        await herdr(socket, "pane.send_text", { pane_id: pane(), text: "u7-go" })
        await herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] })
        await until("the main agent's turn ends", () => ran.sleep !== undefined, 240_000).catch(async (e: Error) => {
          throw await why(e)
        })
        expect(
          ran.update!.includes("load") && ran.update!.includes("in place") && ran.update!.includes(before.id),
          `vibest update did not say the main agent reloads by itself: ${ran.update}`,
        )
        expect(versionAtSleepResult === OLD, `the module reloaded during the turn: ${versionAtSleepResult}`)
        await until("the main agent reloads the new module", () => main()?.version !== OLD, 120_000).catch(
          async (e: Error) => {
            throw await why(e)
          },
        )
        const after = main()!
        expect(after.version !== null, `no integration version: ${JSON.stringify(after)}`)
        expect(after.id === before.id, `the main agent's session changed: ${before.id} -> ${after.id}`)
        expect(
          after.pid === before.pid && alive(before.pid!),
          `the main agent was restarted: ${before.pid} -> ${after.pid}`,
        )
        expect(
          after.conversation === before.conversation,
          `the conversation changed: ${before.conversation} -> ${after.conversation}`,
        )
        // The subagent's result reaches the main agent once, whether it came before or after the reload.
        const sub = /\\?"id\\?":\\?"([0-9a-f]{8})/.exec(ran.run!)?.[1]
        expect(sub !== undefined, `vibest run printed no session id: ${ran.run}`)
        const shown = () => claude.seen.at(-1)!.filter((m) => m.startsWith("user: ") && m.includes(`(${sub})`)).length
        await until("the subagent's result in the main agent's conversation", () => shown() > 0, 120_000).catch(
          async (e: Error) => {
            throw await why(e)
          },
        )
        await until("its row delivered", () => inbox(before.id).some((r) => r.status === "delivered"), 30_000)
        await Bun.sleep(5_000)
        expect(shown() === 1, `the result was shown ${shown()} times: ${JSON.stringify(claude.seen.at(-1))}`)
        const rows = inbox(before.id)
        expect(rows.length === 1 && rows[0]!.status === "delivered", `the main agent's inbox: ${JSON.stringify(rows)}`)
        // The result arrived while the old module still ran the turn: it took it, the new one must not show it again.
        expect(
          inboxAtTurnEnd.length === 1 && inboxAtTurnEnd[0]!.status !== "pending",
          `the result was not taken before the reload (the subagent was slow?): ${JSON.stringify(inboxAtTurnEnd)}`,
        )
        const all = claude.seen.flat().join("\n")
        expect(!all.includes("continue the interrupted work"), "a continue notice reached the main agent")
        expect(
          claude.seen.some((m) => m.some((x) => x.startsWith("assistant: ") && x.includes("turn-done"))),
          "the turn's last answer is not in the conversation",
        )
      } finally {
        claude.stop()
        pi.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U5",
    title:
      "a usage-limit move in place: a Pi subagent whose turn hits a usage limit ends only its harness; the next login runs in the same pane (herdr lists it as s-<id> there) and finishes the round",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // The first login (/v1) is on its usage limit (Pi retries a failed request, so every one fails); the second (/v2) answers.
      const seen: Array<string> = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: async (req) => {
          const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
          const last = text(messages.at(-1))
          seen.push(`${new URL(req.url).pathname} ${last.slice(-80)}`)
          if (new URL(req.url).pathname.startsWith("/v1/"))
            // An error inside the stream: Pi reports its message as the turn's error, as a provider's limit text.
            return new Response(
              `data: ${JSON.stringify({ error: { message: "usage limit reached, try again later" } })}\n\n`,
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          const chunk = (o: object) =>
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
          const content = /done-limit/.test(last) ? "done-limit\nstatus: completed" : "ok"
          return new Response(
            chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
              chunk({
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const session = `${w.herdrSession}-move`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const plugin = path.join(w.vibestHome, "plugins", "move.ts")
      try {
        const repo = await project(w, "move")
        const agentDir = path.join(w.root, "pi-move")
        await fs.mkdir(agentDir, { recursive: true })
        const provider = (base: string) => ({
          baseUrl: `http://127.0.0.1:${server.port}/${base}`,
          apiKey: "fake",
          api: "openai-completions",
          models: [{ id: "m", contextWindow: 100_000, maxTokens: 1000 }],
        })
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify({ providers: { first: provider("v1"), second: provider("v2") } }),
        )
        // The move's choice: the same harness on the other login.
        await fs.mkdir(path.dirname(plugin), { recursive: true })
        await fs.writeFile(
          plugin,
          `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({
  id: "move-e2e",
  effect: (ctx) => ctx.agent.hook("fail", (e) => Effect.sync(() => { e.move = { harness: "pi", provider: "second", model: "m" } })),
})
`,
        )
        // vibestd lists Pi's models with this agent dir, and the herdr server it starts hands it to the panes.
        const env = { PI_CODING_AGENT_DIR: agentDir }
        await w.stopDaemon()
        await w.ok(["daemon"], { cwd: repo, env })
        await until(
          "the move plugin is active",
          async () =>
            (await w.json<Array<{ id: string; status: string }>>(["plugins"], { cwd: repo, env })).some(
              (p) => p.id === "move-e2e" && p.status === "active",
            ),
          30_000,
        )
        const id = (
          JSON.parse(
            await w.ok(["run", "pi", "--provider", "first", "--model", "m", "--session", session, ask("limit")], {
              cwd: repo,
              env,
              timeoutMs: 120_000,
            }),
          ) as { id: string }
        ).id
        type Moved = { harness: string; provider: string | null; pid: number | null; conversation: string | null }
        const row = () => {
          const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
          try {
            return db
              .query<Moved, [string]>(
                `SELECT harness, json_extract(metadata, '$.provider') AS provider, json_extract(metadata, '$.pid') AS pid,
                   harness_session_id AS conversation FROM session WHERE id = ?`,
              )
              .get(id)!
          } finally {
            db.close()
          }
        }
        const status = () => {
          const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
          try {
            return db.query<{ status: string }, [string]>("SELECT status FROM message WHERE session_id = ?").all(id)
          } finally {
            db.close()
          }
        }
        // undefined until the subagent's herdr session is up.
        const listed = async () =>
          ((await herdr(socket, "agent.list", {}).catch(() => ({ agents: [] }))).agents as Array<Agent>).find(
            (a) => a.name === `s-${id}`,
          )
        const log = async () =>
          (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000)
        await until("herdr lists the subagent as s-<id>", async () => (await listed())?.agent === "pi", 60_000)
        const pane = (await listed())!.pane_id
        await until("the first login's harness reports its pid", () => row().pid !== null, 60_000)
        const before = row()
        await until(
          "the move to the second login",
          () => row().provider === "second" && row().pid !== null && row().pid !== before.pid,
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(
            `${e.message}; row ${JSON.stringify(row())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
          )
        })
        expect(!alive(before.pid!), `the limited harness ${before.pid} still runs`)
        expect(alive(row().pid!), `the moved harness ${row().pid} does not run`)
        expect(row().harness === "pi", `moved to ${row().harness}`)
        await until(
          "the round completes on the second login",
          () => status().some((m) => m.status === "completed"),
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(
            `${e.message}; rounds ${JSON.stringify(status())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
          )
        })
        expect(status().length === 1, `one round: ${JSON.stringify(status())}`)
        expect(
          seen.some((s) => s.startsWith("/v2/")),
          `the second login got no request: ${JSON.stringify(seen)}`,
        )
        const after = await listed()
        expect(after?.agent === "pi" && after.pane_id === pane, `herdr lists s-${id} at ${after?.pane_id}, not ${pane}`)
      } finally {
        server.stop(true)
        await fs.rm(plugin, { force: true })
        await w.stopDaemon()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default checks
