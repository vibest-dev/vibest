import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, row, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, piDir, project as newRepository } from "./inbox.ts"

type Info = { directory: string; preferences: string; docs: string; memories: string; artifacts: string }

type Step = { readonly tool: string; readonly input: Record<string, string> } | string

const filesTurn =
  (results: Record<string, Array<string>>, other: string, names: { write: string; read: string; path: string }) =>
  (who: string, dir: string, done: number, last: string | undefined): Step => {
    if (last !== undefined) (results[who] ??= []).push(last)
    const file = path.join(dir, "artifacts", `${who}.md`)
    if (done === 0) return { tool: names.write, input: { [names.path]: file, content: `${who}-wrote\n` } }
    if (done === 1) return { tool: names.read, input: { [names.path]: file } }
    if (done === 2)
      return { tool: names.write, input: { [names.path]: path.join(other, "artifacts", `${who}.md`), content: "x\n" } }
    return `done-${who}\nstatus: completed`
  }

const fakeOpenAI = (step: ReturnType<typeof filesTurn>, dirs: Record<string, string>) => {
  let calls = 0
  const chunk = (o: object) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
  const done = (finish: string) =>
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) + "data: [DONE]\n\n"
  const answer = (s: Step) =>
    typeof s === "string"
      ? chunk({ choices: [{ index: 0, delta: { role: "assistant", content: s }, finish_reason: null }] }) + done("stop")
      : chunk({
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
                    function: { name: s.tool, arguments: JSON.stringify(s.input) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) + done("tool_calls")
  const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<{ role: string; content: unknown }> }
      const system = text(messages.find((m) => m.role === "system" || m.role === "developer")?.content)
      const main = /The project folder is (\S+) \(VIBEST_PROJECT_DIR\)/.exec(system)
      const sub = /Project folder: (\S+) \(VIBEST_PROJECT_DIR\)/.exec(system)
      const who = main ? "main" : sub ? "pi" : undefined
      const tools = messages.filter((m) => m.role === "tool")
      const last = messages.at(-1)
      const headers = { "content-type": "text/event-stream" }
      const mainTurnNotStartedBySubagentResult =
        who === "main" && tools.length === 0 && !text(last?.content).includes("<agent-")
      if (who === undefined || mainTurnNotStartedBySubagentResult) return new Response(answer("ok"), { headers })
      if (tools.length > 3) return new Response(answer("ok"), { headers })
      dirs[who] = (main ?? sub)![1]!
      const result = last?.role === "tool" ? text(last.content) : undefined
      return new Response(answer(step(who, dirs[who]!, tools.length, result)), { headers })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const fakeAnthropic = (step: ReturnType<typeof filesTurn>, dirs: Record<string, string>) => {
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
        system?: unknown
        tools?: Array<unknown>
        messages?: Array<{ role: string; content: unknown }>
      }
      const blocks = (body.messages ?? []).flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Array<{ type?: string; content?: unknown }>) : [],
      )
      const results = blocks.filter((b) => b.type === "tool_result")
      const dir = /Project folder: (\S+) \(VIBEST_PROJECT_DIR\)/.exec(JSON.stringify(body.system ?? ""))?.[1]
      let content: Array<object> = [{ type: "text", text: "ok" }]
      let stop = "end_turn"
      if ((body.tools?.length ?? 0) > 0 && dir !== undefined && results.length <= 3) {
        dirs.claude = dir
        const last = results.at(-1)
        const s = step("claude", dir, results.length, last === undefined ? undefined : JSON.stringify(last.content))
        if (typeof s === "string") content = [{ type: "text", text: s }]
        else {
          content = [{ type: "tool_use", id: `toolu_${results.length}`, name: s.tool, input: s.input }]
          stop = "tool_use"
        }
      }
      const message = {
        id: `msg_${++n}`,
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content,
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
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
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const autoModeOffSoNoFirstRunQuestionStopsThePane = {
  disableAutoMode: "disable",
  permissions: { defaultMode: "default", disableAutoMode: "disable" },
}

const claudeEnv = async (w: World, name: string, url: string) => {
  const dir = path.join(w.root, `claude-${name}`)
  await fs.mkdir(dir, { recursive: true })
  const key = "sk-ant-e2e-fake-0123456789abcdefghijklmnop"
  await fs.writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    }),
  )
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(autoModeOffSoNoFirstRunQuestionStopsThePane))
  return [`CLAUDE_CONFIG_DIR=${dir}`, `ANTHROPIC_BASE_URL=${url}`, `ANTHROPIC_API_KEY=${key}`].flatMap((pair) => [
    "--env",
    pair,
  ])
}

const checks: ReadonlyArray<Check> = [
  {
    id: "P1",
    title:
      "project info names the project folder (projects/<project id>), its preferences.md, docs, memories and artifacts",
    run: async (w) => {
      const info = await w.json<Info>(["project", "info"])
      const id = path.basename(info.directory)
      expect(
        path.dirname(info.directory) === path.join(w.vibestHome, "projects") && /^[0-9a-f-]{36}$/.test(id),
        `directory: ${JSON.stringify(info)}`,
      )
      for (const [key, rel] of [
        ["preferences", "preferences.md"],
        ["docs", "docs"],
        ["memories", "memories"],
        ["artifacts", "artifacts"],
      ] as const)
        expect(info[key] === path.join(info.directory, rel), `${key}: ${JSON.stringify(info)}`)
      for (const gone of ["read", "write", "list", "delete"]) {
        const r = await w.vibest(["project", gone, "docs", "a.md"])
        expect(r.code !== 0, `project ${gone} exited 0`)
      }
    },
  },
  {
    id: "P2",
    title: "project search finds text in docs, memories and artifacts files, as kind/path:line: text",
    run: async (w) => {
      const info = await w.json<Info>(["project", "info"])
      for (const kind of ["docs", "memories", "artifacts"] as const) {
        await fs.mkdir(path.join(info[kind], "e2e"), { recursive: true })
        await fs.writeFile(path.join(info[kind], "e2e", `${kind}.md`), `# ${kind}\nneedle-${kind}\n`)
        const { hits } = await w.json<{ hits: Array<string> }>(["project", "search", `needle-${kind}`, "--kind", kind])
        expect(
          hits.some((h) => h.startsWith(`${kind}/e2e/${kind}.md:2:`)),
          `${kind}: search ${JSON.stringify(hits)}`,
        )
      }
    },
  },
  {
    id: "P8",
    title:
      "a Pi main agent, a Pi subagent and a Claude subagent (fake models) each write and read artifacts/<who>.md in the project folder with their file tools, without a permission prompt; a write into another project's folder is refused",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const other = path.join(w.vibestHome, "projects", "00000000-0000-4000-8000-000000000000")
      await fs.mkdir(path.join(other, "artifacts"), { recursive: true })
      const results: Record<string, Array<string>> = {}
      const dirs: Record<string, string> = {}
      const pi = fakeOpenAI(filesTurn(results, other, { write: "write", read: "read", path: "path" }), dirs)
      const claude = fakeAnthropic(filesTurn(results, other, { write: "Write", read: "Read", path: "file_path" }), dirs)
      const session = `${w.herdrSession}-files`
      try {
        const repo = await newRepository(w, "files")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-files", pi.url)}`
        const zdot = path.join(w.root, "zdotdir-files")
        await fs.mkdir(zdot, { recursive: true })
        await w.stopDaemon()
        await w.ok(["daemon"], { env: { ZDOTDIR: zdot } })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        const run = async (args: ReadonlyArray<string>) =>
          (
            JSON.parse(
              await w.ok(["run", ...args, "--session", session, "--", "Work in the project folder."], {
                cwd: repo,
                timeoutMs: 60_000,
              }),
            ) as { id: string }
          ).id
        const subs = {
          pi: await run(["pi", "--env", env]),
          claude: await run(["claude", ...(await claudeEnv(w, "files", claude.url))]),
        }
        const answered = (who: string) => (results[who]?.length ?? 0) >= 3
        for (const who of ["pi", "claude", "main"])
          await until(`the ${who} agent's turn on the folder`, () => answered(who), 180_000).catch(async (e: Error) => {
            const peek =
              who === "main" ? undefined : await w.vibest(["peek", subs[who as "pi" | "claude"]], { cwd: repo })
            throw new Error(
              `${e.message}; tool results ${JSON.stringify(results)}; folders ${JSON.stringify(dirs)}${peek ? `; its screen:\n${peek.stdout}` : ""}`,
            )
          })
        const main = (await w.json<Array<{ id: string; agent: string }>>(["ls"], { cwd: repo })).find(
          (e) => e.agent === "main",
        )?.id
        const own = path.join(
          w.vibestHome,
          "projects",
          row<{ p: string }>(w, "SELECT project_id AS p FROM session WHERE id = ?", main ?? "")?.p ?? "",
        )
        for (const who of ["pi", "claude", "main"]) {
          expect(dirs[who] === own, `${who}'s system prompt names ${dirs[who]}, not ${own}`)
          const [, read, refused] = results[who]!
          expect(read!.includes(`${who}-wrote`), `${who} read back: ${read}`)
          const reason = who === "main" ? "edits files only in the project folder" : "off limits to sessions"
          expect(refused!.includes(reason), `${who}'s write into another project: ${refused}`)
          expect(
            (await fs.readFile(path.join(own, "artifacts", `${who}.md`), "utf8")) === `${who}-wrote\n`,
            `artifacts/${who}.md`,
          )
          expect(
            !(await Bun.file(path.join(other, "artifacts", `${who}.md`)).exists()),
            `${who} wrote into another project`,
          )
        }
      } finally {
        pi.stop()
        claude.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "P7",
    title:
      "a moved checkout: other commands name both places; vibest asks [Y/n], y keeps the project id, its repository path and memories, and repairs vibest's worktree",
    run: async (w) => {
      const sh = async (cwd: string, ...argv: Array<string>) => {
        const r = await w.run(cwd, argv)
        expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
        return r.stdout.trim()
      }
      const before = path.join(w.root, "p7", "repo")
      await fs.mkdir(before, { recursive: true })
      await sh(before, "git", "init", "-q", "-b", "main")
      await sh(before, "git", "commit", "-q", "--allow-empty", "-m", "init")
      await sh(before, "git", "remote", "add", "origin", "git@example.com:e2e/p7.git")
      const old = await fs.realpath(before)
      const info = await w.json<Info>(["project", "info"], { cwd: old })
      await fs.mkdir(info.memories, { recursive: true })
      await fs.writeFile(path.join(info.memories, "a.md"), "kept across the move\n")
      const project = row<{ id: string }>(w, "SELECT project_id AS id FROM project_repository WHERE path = ?", old)
      expect(project !== undefined, `no project_repository row for ${old}`)
      const vibestOwnWorktree = path.join(w.vibestHome, "worktrees", "repo", "p7a1")
      await fs.mkdir(path.dirname(vibestOwnWorktree), { recursive: true })
      await sh(old, "git", "worktree", "add", "-q", "--detach", vibestOwnWorktree)

      await fs.rename(old, path.join(w.root, "p7", "moved"))
      const moved = await fs.realpath(path.join(w.root, "p7", "moved"))
      const refused = await w.vibest(["project", "info"], { cwd: moved })
      expect(
        refused.code !== 0 && refused.stderr.includes(old) && refused.stderr.includes(moved),
        `project info in the moved checkout: ${refused.code} ${refused.stderr}${refused.stdout}`,
      )
      const noSuchRuntimeSoNoHarnessRuns = "e2e-none"
      const r = await w.tty(["--headless", "--runtime", noSuchRuntimeSoNoHarnessRuns], "y\n", {
        cwd: moved,
        timeoutMs: 60_000,
      })
      const out = `${r.stdout}${r.stderr}`
      expect(out.includes(`The project moved from ${old} to here, move it? [Y/n]`), `no question: ${out}`)
      expect(out.includes(`moved the project from ${old} to ${moved}`), `not moved: ${out}`)
      expect(!out.includes("a worktree of yours"), `vibest's own worktree was left to the user: ${out}`)
      const after = row<{ id: string }>(w, "SELECT project_id AS id FROM project_repository WHERE path = ?", moved)
      expect(after?.id === project!.id, `the project at ${moved} is ${after?.id}, was ${project!.id}`)
      expect(
        row<{ d: string }>(w, "SELECT directory AS d FROM project WHERE id = ?", project!.id)?.d === moved,
        "project.directory is not the new place",
      )
      const now = await w.json<Info>(["project", "info"], { cwd: moved })
      expect(now.directory === info.directory, `the project folder is now ${now.directory}, was ${info.directory}`)
      const kept = await fs.readFile(path.join(now.memories, "a.md"), "utf8")
      expect(kept.includes("kept across the move"), `memories after the move: ${kept}`)
      await sh(vibestOwnWorktree, "git", "status", "--short")
    },
  },
]

export default checks
