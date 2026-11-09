import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import {
  ask,
  claudeEnv,
  envArgs,
  fakeAnthropic,
  fakeOpenAI,
  heldModel,
  piDir,
  subagentFolder,
  type Step,
} from "../fake-model.ts"
import { expect, row, Skip, until } from "../world.ts"
import { dropHerdrSession, project as newRepository } from "./inbox.ts"

type Info = { directory: string; preferences: string; docs: string; memories: string; artifacts: string }

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
      const other = (await w.json<Info>(["project", "info"], { cwd: await newRepository(w, "files-other") })).directory
      await fs.mkdir(path.join(other, "artifacts"), { recursive: true })
      const results: Record<string, Array<string>> = {}
      const dirs: Record<string, string> = {}
      const pi = fakeOpenAI(filesTurn(results, other, { write: "write", read: "read", path: "path" }), dirs)
      const claudeTurn = filesTurn(results, other, { write: "Write", read: "Read", path: "file_path" })
      const claude = fakeAnthropic((r) => {
        const dir = subagentFolder(r.system)
        if (r.tools.length === 0 || dir === undefined || r.results.length > 3) return "ok"
        dirs.claude = dir
        const last = r.results.at(-1)
        return claudeTurn(
          "claude",
          dir,
          r.results.length,
          last === undefined ? undefined : JSON.stringify(last.content),
        )
      })
      const session = `${w.herdrSession}-files`
      try {
        const repo = await newRepository(w, "files")
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-files", pi.url)}`
        await w.daemon()
        await w.startMain({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: env.slice("PI_CODING_AGENT_DIR=".length) },
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
          claude: await run(["claude", ...envArgs(await claudeEnv(w, "files", claude.url))]),
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
        const pi = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-p7", model.url)}`
        const { id } = JSON.parse(
          await w.ok(["run", "pi", "--session", session, "--env", pi, "--", ask("p7")], {
            cwd: old,
            timeoutMs: 90_000,
          }),
        ) as { id: string }
        await until(
          "the subagent's result",
          async () =>
            (
              (await w.json<{ result?: { message?: string } | null }>(["result", id], { cwd: old })).result?.message ??
              ""
            ).includes("done-p7"),
          90_000,
        )
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
      "vibest ls outside a project lists that project's main agent, and from a git repository that is no project lists nothing, without the CLI running git",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "git"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      await w.startMain({ harness: "pi", env: { PI_CODING_AGENT_DIR: w.config.pi } })
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
      const listed = JSON.parse(await w.ok(["ls"], { cwd: outside, env })) as Array<{ agent: string }>
      expect(
        listed.some((row) => row.agent === "main"),
        `ls outside a project: ${JSON.stringify(listed)}`,
      )
      expect((await fs.readFile(log, "utf8").catch(() => "")) === "", "ls ran git")
      const repo = path.join(w.root, "no-project")
      await fs.mkdir(repo)
      const init = await w.run(repo, ["git", "init", "-q"])
      expect(init.code === 0, init.stderr)
      const none = JSON.parse(await w.ok(["ls"], { cwd: repo, env })) as Array<unknown>
      expect(none.length === 0, `ls in a repository that is no project: ${JSON.stringify(none)}`)
    },
  },

  {
    id: "S38",
    title: "herdr open-main focuses the main agent's pane through vibestd",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      await w.startMain({ harness: "pi", env: { PI_CODING_AGENT_DIR: w.config.pi } })
      const context = JSON.stringify({ workspace_cwd: w.repository })
      const focused = await w.ok(["herdr", "open-main"], { env: { HERDR_PLUGIN_CONTEXT_JSON: context } })
      expect(focused.startsWith("focused "), `open-main: ${focused}`)
    },
  },
]

export default checks
