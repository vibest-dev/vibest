import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import {
  ask,
  claudeEnv,
  creatorIn,
  envArgs,
  fakeAnthropic,
  fakeOpenAI,
  heldModel,
  piDir,
  subagentFolder,
  type Step,
} from "../fake-model.ts"
import { replyOf, binary, expect, herdr, row, Skip, until } from "../world.ts"
import { dropHerdrSession, project as newRepository } from "./inbox.ts"

type Info = { directory: string; preferences: string; docs: string; memories: string; artifacts: string }

const filesExecution =
  (
    results: Record<string, Array<string>>,
    other: string,
    names: { write: string; read: string; path: string; bash: string },
  ) =>
  (who: string, dir: string, done: number, last: string | undefined, creator?: string): Step => {
    if (last !== undefined) (results[who] ??= []).push(last)
    const file = path.join(dir, "artifacts", `${who}.md`)
    if (done === 0) return { tool: names.write, input: { [names.path]: file, content: `${who}-wrote\n` } }
    if (done === 1) return { tool: names.read, input: { [names.path]: file } }
    if (done === 2)
      return { tool: names.write, input: { [names.path]: path.join(other, "artifacts", `${who}.md`), content: "x\n" } }
    if (creator !== undefined)
      return { tool: names.bash, input: { command: `${binary} send ${creator} -- 'done-${who}'` } }
    return `done-${who}`
  }

const checks: ReadonlyArray<Check> = [
  {
    id: "P2",
    covers: ["P1"],
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
      "a Pi entry session, a Pi subagent and a Claude subagent (fake models) each write and read artifacts/<who>.md in the project folder with their file tools, without a permission prompt; a write into another project's folder is refused",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const other = (await w.json<Info>(["project", "info"], { cwd: await newRepository(w, "files-other") })).directory
      await fs.mkdir(path.join(other, "artifacts"), { recursive: true })
      const results: Record<string, Array<string>> = {}
      const dirs: Record<string, string> = {}
      const pi = fakeOpenAI(
        filesExecution(results, other, { write: "write", read: "read", path: "path", bash: "bash" }),
        dirs,
      )
      const claudeExecution = filesExecution(results, other, {
        write: "Write",
        read: "Read",
        path: "file_path",
        bash: "Bash",
      })
      const claude = fakeAnthropic((r) => {
        const dir = subagentFolder(r.system)
        if (r.tools.length === 0 || dir === undefined || r.results.length > 3) return "ok"
        dirs.claude = dir
        const last = r.results.at(-1)
        return claudeExecution(
          "claude",
          dir,
          r.results.length,
          last === undefined ? undefined : JSON.stringify(last.content),
          creatorIn(r.system),
        )
      })
      const session = `${w.herdrSession}-files`
      try {
        const repo = await newRepository(w, "files")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-files", pi.url)}`
        await w.daemon()
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
          timeoutMs: 60_000,
        })
        const run = async (args: ReadonlyArray<string>) =>
          (
            JSON.parse(
              await w.okViaEntry(["run", ...args, "--session", session, "--", "Work in the project folder."], {
                cwd: repo,
                timeoutMs: 60_000,
              }),
            ) as { id: string }
          ).id
        const subs = {
          pi: await run(["pi", "--env", env]),
          claude: await run(["claude", ...envArgs(await claudeEnv(w, "files", claude.url))]),
        }
        const answered = (who: string) => (results[who]?.length ?? 0) >= 3
        for (const who of ["pi", "claude", "main"])
          await until(`the ${who} agent's execution on the folder`, () => answered(who), 180_000).catch(
            async (e: Error) => {
              const peek =
                who === "main" ? undefined : await w.vibest(["peek", subs[who as "pi" | "claude"]], { cwd: repo })
              throw new Error(
                `${e.message}; tool results ${JSON.stringify(results)}; folders ${JSON.stringify(dirs)}${peek ? `; its screen:\n${peek.stdout}` : ""}`,
              )
            },
          )
        const entryId = (
          await w
            .json<{ sessions: Array<{ id: string; agent: string }> }>(["ls"], { cwd: repo })
            .then((l) => l.sessions)
        ).find((e) => e.agent === "coordinator")?.id
        const own = path.join(
          w.vibestHome,
          "projects",
          row<{ p: string }>(w, "SELECT project_id AS p FROM session WHERE id = ?", entryId ?? "")?.p ?? "",
        )
        for (const who of ["pi", "claude", "main"]) {
          expect(dirs[who] === own, `${who}'s system prompt names ${dirs[who]}, not ${own}`)
          const [, read, refused] = results[who]!
          expect(read!.includes(`${who}-wrote`), `${who} read back: ${read}`)
          const reason = "off limits to sessions"
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
      "a moved checkout: other commands name both places; vibest asks [Y/n], y keeps the project id, its repository path and memories, and repairs the worktree vibest run made (the answering vibest names a runtime that does not exist, so no harness starts)",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
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
      const model = heldModel()
      model.release()
      const session = `${w.herdrSession}-p7`
      let vibestOwnWorktree = ""
      try {
        await w.daemon()
        await w.entry({ cwd: old, session })
        const pi = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-p7", model.url)}`
        const { id } = JSON.parse(
          await w.okViaEntry(["run", "pi", "--session", session, "--env", pi, "--", ask("p7")], {
            cwd: old,
            timeoutMs: 90_000,
          }),
        ) as { id: string }
        await until("the subagent's answer", async () => (await replyOf(w, id, old)).includes("done-p7"), 90_000)
        vibestOwnWorktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", id)?.d ?? ""
        expect(vibestOwnWorktree.startsWith(w.vibestHome), `vibest run made no worktree: ${vibestOwnWorktree}`)
        await w.ok(["archive", id, "--keep-worktree"], { cwd: old, timeoutMs: 60_000 })
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }

      await fs.rename(old, path.join(w.root, "p7", "moved"))
      const moved = await fs.realpath(path.join(w.root, "p7", "moved"))
      const refused = await w.vibest(["project", "info"], { cwd: moved })
      expect(
        refused.code !== 0 && refused.stderr.includes(old) && refused.stderr.includes(moved),
        `project info in the moved checkout: ${refused.code} ${refused.stderr}${refused.stdout}`,
      )
      const missingRuntime = "e2e-none"
      const r = await w.tty(["--headless", "--runtime", missingRuntime], "y\n", {
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

  {
    id: "S37",
    title:
      "vibest ls outside a project lists that project's entry session, and from a git repository that is no project lists nothing, without the CLI running git",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "git"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      await w.startEntry({ harness: "pi", env: { PI_CODING_AGENT_DIR: w.config.pi } })
      const outside = await fs.mkdtemp(path.join(w.root, "outside-"))
      const log = path.join(w.root, "git-calls")
      const shim = path.join(w.root, "git-shim")
      await fs.mkdir(shim)
      await fs.writeFile(
        path.join(shim, "git"),
        `#!/bin/sh\necho "$@" >> '${log}'\nexec '${Bun.which("git")}' "$@"\n`,
        { mode: 0o755 },
      )
      const env = { PATH: `${shim}:${w.env().PATH}` }
      const listed = (JSON.parse(await w.ok(["ls"], { cwd: outside, env })) as { sessions: Array<{ agent: string }> })
        .sessions
      expect(
        listed.some((row) => row.agent === "coordinator"),
        `ls outside a project: ${JSON.stringify(listed)}`,
      )
      expect((await fs.readFile(log, "utf8").catch(() => "")) === "", "ls ran git")
      const repo = path.join(w.root, "no-project")
      await fs.mkdir(repo)
      const init = await w.run(repo, ["git", "init", "-q"])
      expect(init.code === 0, init.stderr)
      const none = (JSON.parse(await w.ok(["ls"], { cwd: repo, env })) as { sessions: Array<unknown> }).sessions
      expect(none.length === 0, `ls in a repository that is no project: ${JSON.stringify(none)}`)
    },
  },

  {
    id: "S38",
    title: "herdr open-entry focuses the entry session's pane through vibestd",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      await w.startEntry({ harness: "pi", env: { PI_CODING_AGENT_DIR: w.config.pi } })
      const context = JSON.stringify({ workspace_cwd: w.repository })
      const focused = await w.ok(["herdr", "open-entry"], { env: { HERDR_PLUGIN_CONTEXT_JSON: context } })
      expect(focused.startsWith("focused "), `open-entry: ${focused}`)
      const socket = path.join(w.home, ".config", "herdr", "sessions", w.herdrSession, "herdr.sock")
      const panes = async () =>
        ((await herdr(socket, "pane.list", {})) as { panes: Array<{ pane_id: string }> }).panes.map((p) => p.pane_id)
      let entryPane = ""
      await until(
        "the entry session's pane",
        async () => {
          for (const id of await panes()) {
            const info = (await herdr(socket, "pane.process_info", { pane_id: id })) as {
              process_info?: { foreground_processes?: Array<{ name?: string; argv0?: string | null }> }
            }
            const fg = info.process_info?.foreground_processes ?? []
            if (fg.some((proc) => (proc.argv0 ?? proc.name ?? "").includes("pi"))) {
              entryPane = id
              return true
            }
          }
          return false
        },
        30_000,
      )
      const before = new Set(await panes())
      await herdr(socket, "pane.close", { pane_id: entryPane })
      await until("the entry session pane closed", async () => !(await panes()).includes(entryPane), 15_000)
      const opened = await w.ok(["herdr", "open-entry"], {
        env: { HERDR_PLUGIN_CONTEXT_JSON: context, HERDR_SOCKET_PATH: socket },
      })
      expect(opened.startsWith("opened "), `open-entry after quit: ${opened}`)
      const after = await panes()
      expect(
        after.some((id) => !before.has(id)),
        `no new pane in ${after.join(",")}`,
      )
    },
  },
  {
    id: "P9",
    title:
      "vibest project create through vibestd: relative --from against the CLI directory; an agent is refused; a non-empty target is left untouched",
    run: async (w) => {
      const root = path.join(w.root, "p9")
      const cwd = path.join(root, "work")
      await fs.mkdir(cwd, { recursive: true })
      for (const name of ["a", "b"]) {
        const dir = path.join(root, name)
        await fs.mkdir(dir)
        for (const argv of [
          ["git", "init", "-q", "-b", "main"],
          ["git", "add", "f"],
          ["git", "commit", "-q", "-m", "f"],
        ]) {
          if (argv[1] === "add") await fs.writeFile(path.join(dir, "f"), "x\n")
          const ran = await w.run(dir, argv)
          expect(ran.code === 0, `${name} ${argv.join(" ")}: ${ran.stderr}`)
        }
      }
      const created = await w.json<{ directory: string; folders: Array<{ name: string }> }>(
        ["project", "create", "combo", "--from", "../a", "--from", "../b"],
        { cwd },
      )
      expect((await fs.realpath(created.directory)) === (await fs.realpath(path.join(cwd, "combo"))), created.directory)
      expect(created.folders.map((folder) => folder.name).join(",") === "a,b", JSON.stringify(created.folders))
      const agent = await w.vibest(["project", "create", "agent", "--from", "../a"], {
        cwd,
        env: { VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" },
      })
      expect(agent.code !== 0 && agent.stderr.includes("Forbidden"), agent.stderr)
      expect(
        !(await fs.stat(path.join(cwd, "agent")).then(
          () => true,
          () => false,
        )),
        "an agent created a project",
      )
      const full = path.join(cwd, "full")
      await fs.mkdir(full)
      await fs.writeFile(path.join(full, "keep"), "keep\n")
      const refused = await w.vibest(["project", "create", "full", "--from", "../a"], { cwd })
      expect(refused.code !== 0 && refused.stderr.includes("not empty"), refused.stderr)
      expect((await fs.readFile(path.join(full, "keep"), "utf8")) === "keep\n", "the non-empty target was touched")
    },
  },
]

export default checks
