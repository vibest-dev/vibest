import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, row, until, type World } from "../world.ts"

type Entry = { path: string; version: string }
const KINDS = ["docs", "memory", "scratch"] as const

const write = (w: World, kind: string, file: string, content: string, ifVersion: string) =>
  w.json<{ version: string }>(["project", "write", kind, file, "--if-version", ifVersion, "--", content])
const read = (w: World, kind: string, file: string) =>
  w.json<{ content: string; version: string }>(["project", "read", kind, file])

const checks: ReadonlyArray<Check> = [
  {
    id: "P1",
    title: "project info in a repository",
    run: async (w) => {
      const info = await w.json<{ instructions: string; docs: Array<Entry>; memory: Array<Entry> }>(["project", "info"])
      expect(typeof info.instructions === "string", `no instructions: ${JSON.stringify(info)}`)
      expect(Array.isArray(info.docs) && Array.isArray(info.memory), `kinds missing: ${JSON.stringify(info)}`)
    },
  },
  {
    id: "P2",
    title: "write, read, list, search and delete round-trip for docs, memory and scratch",
    run: async (w) => {
      for (const kind of KINDS) {
        const file = `e2e/${kind}.md`
        const { version } = await write(w, kind, file, `# ${kind}\nneedle-${kind}\n`, "new")
        const got = await read(w, kind, file)
        expect(
          got.version === version && got.content.includes(`needle-${kind}`),
          `${kind}: read ${JSON.stringify(got)}`,
        )
        expect(got.content.includes("<project-data"), `${kind}: read is not marked as data`)
        const { entries } = await w.json<{ entries: Array<Entry> }>(["project", "list", kind])
        expect(
          entries.some((e) => e.path === file && e.version === version),
          `${kind}: list ${JSON.stringify(entries)}`,
        )
        const { hits } = await w.json<{ hits: Array<string> }>(["project", "search", `needle-${kind}`, "--kind", kind])
        expect(
          hits.some((h) => h.startsWith(`${kind}/${file}:2:`)),
          `${kind}: search ${JSON.stringify(hits)}`,
        )
        await w.ok(["project", "delete", kind, file, "--if-version", version])
        const after = await w.vibest(["project", "read", kind, file])
        expect(after.code !== 0, `${kind}: read after delete exited 0`)
      }
    },
  },
  {
    id: "P3",
    title: "--if-version conflicts refuse write and delete and leave the entry",
    run: async (w) => {
      const { version } = await write(w, "docs", "conflict.md", "one\n", "new")
      for (const args of [
        ["project", "write", "docs", "conflict.md", "--if-version", "new", "--", "two\n"],
        ["project", "write", "docs", "conflict.md", "--if-version", "stale", "--", "two\n"],
        ["project", "delete", "docs", "conflict.md", "--if-version", "stale"],
      ]) {
        const r = await w.vibest(args)
        expect(r.code !== 0, `${args.join(" ")} exited 0`)
      }
      const got = await read(w, "docs", "conflict.md")
      expect(got.version === version && got.content.includes("one"), `entry changed: ${JSON.stringify(got)}`)
    },
  },
  {
    id: "P4",
    title: "a secret-looking value is refused and nothing is written",
    run: async (w) => {
      const r = await w.vibest([
        "project",
        "write",
        "memory",
        "secret.md",
        "--if-version",
        "new",
        "--",
        "API_KEY=Zx9Qv7Lm2Rt8Kp4Wn6Yb3Hc5Jd1Fg0Sa\n",
      ])
      expect(r.code !== 0 && /secret/i.test(r.stderr), `not refused: ${r.code} ${r.stderr}`)
      expect((await w.vibest(["project", "read", "memory", "secret.md"])).code !== 0, "the secret was written")
    },
  },
  {
    id: "P5",
    title: "entries survive a daemon restart",
    run: async (w) => {
      const { version } = await write(w, "memory", "durable.md", "kept across restarts\n", "new")
      const before = await w.daemonPid()
      {
        const r = await w.tty(["daemon", "restart"], "y\n")
        expect(r.code === 0, `daemon restart exited ${r.code}: ${r.stdout}${r.stderr}`)
      }
      await until("a new vibestd", async () => {
        const pid = await w.daemonPid()
        return pid !== undefined && pid !== before
      })
      const got = await read(w, "memory", "durable.md")
      expect(
        got.version === version && got.content.includes("kept across restarts"),
        `after restart: ${JSON.stringify(got)}`,
      )
    },
  },
  {
    id: "P7",
    title:
      "a moved checkout: other commands name both places; vibest asks [Y/n], y keeps the project id, its repository path and memory, and repairs vibest's worktree",
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
      await w.ok(["project", "write", "memory", "a.md", "--if-version", "new", "--", "kept across the move\n"], {
        cwd: old,
      })
      const project = row<{ id: string }>(w, "SELECT project_id AS id FROM project_repository WHERE path = ?", old)
      expect(project !== undefined, `no project_repository row for ${old}`)
      // A worktree where vibest keeps its own, as `vibest run` makes one.
      const worktree = path.join(w.vibestHome, "worktrees", "repo", "p7a1")
      await fs.mkdir(path.dirname(worktree), { recursive: true })
      await sh(old, "git", "worktree", "add", "-q", "--detach", worktree)

      await fs.rename(old, path.join(w.root, "p7", "moved"))
      const moved = await fs.realpath(path.join(w.root, "p7", "moved"))
      const info = await w.vibest(["project", "info"], { cwd: moved })
      expect(
        info.code !== 0 && info.stderr.includes(old) && info.stderr.includes(moved),
        `project info in the moved checkout: ${info.code} ${info.stderr}${info.stdout}`,
      )
      // y moves it; the start after it fails on a runtime that does not exist, so no harness runs.
      const r = await w.tty(["--headless", "--runtime", "e2e-none"], "y\n", { cwd: moved, timeoutMs: 60_000 })
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
      const got = await w.json<{ content: string }>(["project", "read", "memory", "a.md"], { cwd: moved })
      expect(got.content.includes("kept across the move"), `memory after the move: ${JSON.stringify(got)}`)
      await sh(worktree, "git", "status", "--short")
    },
  },
  {
    id: "P6",
    title: "paths that leave the kind are refused",
    run: async (w) => {
      for (const file of ["../escape.md", "/etc/passwd", "a/../../escape.md"]) {
        const r = await w.vibest(["project", "write", "docs", file, "--if-version", "new", "--", "x\n"])
        expect(r.code !== 0, `write ${file} exited 0`)
        expect((await w.vibest(["project", "read", "docs", file])).code !== 0, `read ${file} exited 0`)
      }
    },
  },
]

export default checks
