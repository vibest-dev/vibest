import fs from "node:fs/promises"
import path from "node:path"

import { PROTOCOL } from "../../../packages/schema/src/version.ts"
import type { Check } from "../check.ts"
import { ask } from "../fake-model.ts"
import { binary, expect, until, type World } from "../world.ts"
import { olderBuild } from "../world/older-build.ts"
import { setup, type Setup } from "./machines.ts"

const git = async (w: World, cwd: string, ...args: ReadonlyArray<string>) => {
  const r = await w.run(cwd, ["git", ...args])
  expect(r.code === 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`)

  return r.stdout.trim()
}

const ADMIN = "https://example.com/o/admin"

const twoRepositories = async (w: World) => {
  const combo = path.join(w.root, "combo")
  const shop = path.join(combo, "shop")
  const admin = path.join(combo, "admin")
  await fs.mkdir(combo, { recursive: true })
  await git(w, w.root, "clone", "-q", w.origin, shop)
  await git(w, shop, "remote", "set-url", "origin", "git@gh-shop:o/shop.git")
  await git(w, combo, "init", "-q", "-b", "main", admin)
  await fs.writeFile(path.join(admin, "README.md"), "# admin\n")
  await git(w, admin, "add", ".")
  await git(w, admin, "commit", "-q", "-m", "init")
  await git(w, admin, "remote", "add", "origin", ADMIN)

  return { combo, shop, admin }
}

const BEFORE_REPOSITORY_LISTS = "55868c318d60222aa0c6a8c3e417bf8ce2b8dd54"
const BEFORE_REPOSITORY_LISTS_PROTOCOL = 13

const withCurrentProtocol = (bytes: Buffer, label: string) => {
  const found = [
    ...bytes.toString("latin1").matchAll(new RegExp(`PROTOCOL\\d* = ${BEFORE_REPOSITORY_LISTS_PROTOCOL}\\b`, "g")),
  ]

  expect(
    found.length === 1,
    `${label}: expected one PROTOCOL = ${BEFORE_REPOSITORY_LISTS_PROTOCOL}, found ${found.length}`,
  )
  const from = found[0]![0]
  const to = from.replace(/\d+$/, String(PROTOCOL).padStart(String(BEFORE_REPOSITORY_LISTS_PROTOCOL).length))
  const at = bytes.indexOf(from)
  expect(
    at >= 0 && bytes.indexOf(from, at + 1) < 0 && from.length === to.length,
    `${label}: cannot swap ${from} for ${to}`,
  )
  bytes.write(to, at)
}

const beforeRepositoryLists = async (w: World) => {
  const built = await olderBuild(BEFORE_REPOSITORY_LISTS)
  const dir = path.join(w.root, "before-repository-lists")
  const bin = path.join(dir, "bin", "vibest")
  await fs.mkdir(path.dirname(bin), { recursive: true })
  const bytes = Buffer.from(await fs.readFile(built))
  withCurrentProtocol(bytes, built)
  await fs.writeFile(bin, bytes, { mode: 0o755 })

  if (process.platform === "darwin") {
    const signed = await w.run(dir, ["codesign", "--force", "-s", "-", bin])
    expect(signed.code === 0, `codesign: ${signed.stderr}${signed.stdout}`)
  }

  const builtHarnesses = path.join(path.dirname(path.dirname(built)), "harnesses")
  await fs.cp(builtHarnesses, path.join(dir, "harnesses"), { recursive: true })
  const extension = path.join(dir, "harnesses", "pi", "extension.mjs")
  const source = Buffer.from(await fs.readFile(extension))
  withCurrentProtocol(source, extension)
  await fs.writeFile(extension, source)

  return bin
}

const checks: ReadonlyArray<Check> = [
  {
    id: "M11",
    title:
      "a project of two repositories: B lacking one of them is refused naming it and vibest project add; B lacking A's commit is refused naming the checkout and the commit; once B has both, the session on B runs in one worktree holding A's two folder names, each detached at A's commit",
    run: async (w) => {
      let s: Setup | undefined

      try {
        const a = await twoRepositories(w)
        s = await setup(w, { aProject: a.combo })
        await s.okA(["machine", "add", "mb", "b-host"])
        await s.refusedOnA("mlack", `has no checkout of ${ADMIN}`, "vibest project add")

        const work = path.join(s.b, "work")
        await fs.mkdir(work)
        await git(w, w.root, "clone", "-q", w.origin, path.join(work, "store"))
        await git(w, path.join(work, "store"), "remote", "set-url", "origin", "https://example.com/o/shop")
        await git(w, w.root, "clone", "-q", a.admin, path.join(work, "backoffice"))
        await git(w, path.join(work, "backoffice"), "remote", "set-url", "origin", ADMIN)
        const added = await s.onB(["project", "add"], work)
        expect(added.code === 0, `B: vibest project add in ${work}: ${added.stderr}${added.stdout}`)

        await fs.writeFile(path.join(a.admin, "local.txt"), "only on A\n")
        await git(w, a.admin, "add", ".")
        await git(w, a.admin, "commit", "-q", "-m", "local")
        const commit = await git(w, a.admin, "rev-parse", "HEAD")
        await s.refusedOnA("mcommit", `backoffice does not have ${commit}`, "push it and fetch it there")

        await git(w, path.join(work, "backoffice"), "fetch", "-q", a.admin, "main")
        const address = await s.run("mtworepos")
        await until("the message on A", () => s!.notices(address, "mtworepos") === 1, 120_000)

        const inCombo = async (args: ReadonlyArray<string>) => {
          const r = await w.run(a.combo, [binary, ...args], { env: s!.aEnv })
          expect(r.code === 0, `A: vibest ${args.join(" ")} in ${a.combo}: ${r.stderr}${r.stdout}`)

          return r.stdout
        }

        const got = JSON.parse(await inCombo(["result", address])) as { worktree: string }
        const folders = (await fs.readdir(got.worktree)).filter((name) => !name.startsWith(".")).sort()
        expect(folders.join() === "admin,shop", `B's worktree ${got.worktree} holds ${folders.join()}`)

        for (const [folder, at] of [
          ["shop", a.shop],
          ["admin", a.admin],
        ] as const) {
          const there = path.join(got.worktree, folder)
          const head = await git(w, there, "rev-parse", "HEAD")
          const branch = await w.run(there, ["git", "symbolic-ref", "-q", "HEAD"])
          expect(
            head === (await git(w, at, "rev-parse", "HEAD")) && branch.code !== 0,
            `${there}: HEAD ${head}, branch ${branch.stdout}`,
          )
        }

        await inCombo(["archive", address])
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M12",
    title:
      "a project of two repositories and a B running a vibest built from before repository lists: run --machine is refused on A with run vibest update on B, and B starts nothing",
    run: async (w) => {
      let s: Setup | undefined

      try {
        const a = await twoRepositories(w)
        s = await setup(w, { aProject: a.combo, bBinary: await beforeRepositoryLists(w) })
        await s.okA(["machine", "add", "mb", "b-host"])
        await s.refusedOnA("mold", "run vibest update on mb")
        const started = s.bDb<{ n: number }>("SELECT count(*) AS n FROM session")?.n
        expect(started === 0, `B has ${started} sessions`)
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M13",
    title:
      "B with two projects of A's repository: run --machine is refused listing both with their ids and folders and saying to pass --project; --project with the second's folder name runs there",
    run: async (w) => {
      let s: Setup | undefined

      try {
        s = await setup(w)
        const second = path.join(s.b, "shop-two")
        await git(w, w.root, "clone", "-q", w.origin, second)
        await git(w, second, "remote", "set-url", "origin", "https://example.com/o/shop")
        const added = await s.onB(["project", "add"], second)
        expect(added.code === 0, `B: vibest project add in ${second}: ${added.stderr}${added.stdout}`)
        const secondId = (JSON.parse(added.stdout) as { projectId: string }).projectId
        await s.okA(["machine", "add", "mb", "b-host"])
        await s.refusedOnA("mtwo", "has several projects for", `${secondId} (`, "shop-two)", "pass --project")

        const chosen = JSON.parse(
          await w.okViaEntry(["run", "--machine", "mb", "--project", "shop-two", "pi", "--", ask("mchosen")], {
            env: s.aEnv,
            asIs: true,
          }),
        ) as { id: string; machine?: string }

        const address = `${chosen.machine}/${chosen.id.slice(0, 8)}`

        await until("the message on A", () => s!.notices(address, "mchosen") === 1, 120_000)
        const got = JSON.parse(await s.okA(["result", address])) as { worktree: string }
        const common = await git(w, got.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
        expect(
          common === path.join(await fs.realpath(second), ".git"),
          `the session on B runs in ${got.worktree} of ${common}`,
        )
        await s.okA(["archive", address])
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M14",
    title:
      "vibest project clone --machine clones a repository served over git:// into B's cloneDirectory, prints git's progress and the new project of B; a second clone into the same folder, asked by an agent, is refused as not empty; without --machine it clones here into --dir",
    run: async (w) => {
      let s: Setup | undefined
      let daemon: ReturnType<typeof Bun.spawn> | undefined

      try {
        s = await setup(w)
        const served = path.join(w.root, "served")
        await fs.mkdir(served)
        await git(w, w.root, "clone", "-q", "--bare", w.origin, path.join(served, "tools.git"))
        const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
        const port = probe.port
        probe.stop(true)
        daemon = Bun.spawn(
          [
            "git",
            "daemon",
            "--reuseaddr",
            "--export-all",
            `--base-path=${served}`,
            "--listen=127.0.0.1",
            `--port=${port}`,
            served,
          ],
          { stdout: "ignore", stderr: "ignore" },
        )
        const url = `git://127.0.0.1:${port}/tools.git`
        await until(
          "git daemon serves",
          async () => (await w.run(w.root, ["git", "ls-remote", url])).code === 0,
          15_000,
        )

        const clones = path.join(s.b, "clones")
        await fs.writeFile(path.join(s.bEnv.VIBEST_HOME, "vibest.json"), JSON.stringify({ cloneDirectory: clones }))
        await s.okA(["machine", "add", "mb", "b-host"])
        const cloned = await s.onA(["project", "clone", url, "--machine", "mb"])
        expect(cloned.code === 0, `project clone --machine mb: ${cloned.stderr}${cloned.stdout}`)
        const added = JSON.parse(cloned.stdout) as { projectId: string; directory: string; machine: string }
        const there = path.join(await fs.realpath(clones), "tools")
        expect(
          added.machine === "mb" && added.directory === there && cloned.stderr.includes(`cloning ${url}`),
          `project clone printed ${cloned.stdout} and ${cloned.stderr}`,
        )
        const recorded = s.bDb<{ directory: string }>("SELECT directory FROM project WHERE id = ?", added.projectId)
        expect(recorded?.directory === there, `B's project row: ${JSON.stringify(recorded)}`)
        expect(
          (await git(w, there, "rev-parse", "HEAD")) === (await git(w, w.repository, "rev-parse", "origin/main")),
          "B's clone is at the default branch",
        )

        const again = await w.viaEntry(["project", "clone", url, "--machine", "mb"], { env: s.aEnv, asIs: true })
        expect(
          again.code !== 0 && again.stderr.includes(`${path.join(clones, "tools")} is not empty`),
          `second clone: ${again.stderr}`,
        )

        const here = path.join(w.root, "here-tools")
        const local = await s.onA(["project", "clone", url, "--dir", here])
        expect(local.code === 0, `project clone --dir: ${local.stderr}${local.stdout}`)
        expect(
          (JSON.parse(local.stdout) as { directory: string }).directory === (await fs.realpath(here)),
          `local clone: ${local.stdout}`,
        )
      } finally {
        daemon?.kill()
        await s?.stop()
      }
    },
  },
  {
    id: "M15",
    title:
      "a new vibest CLI whose local vibestd predates --project refuses run --machine --project with run vibest update, and B starts nothing",
    run: async (w) => {
      let s: Setup | undefined

      try {
        s = await setup(w, { aDaemonBinary: await beforeRepositoryLists(w) })
        await s.okA(["machine", "add", "mb", "b-host"])

        const r = await w.viaEntry(["run", "--machine", "mb", "--project", "elsewhere", "pi", "--", "say hello"], {
          env: s.aEnv,
          asIs: true,
        })

        expect(
          r.code !== 0 && r.stderr.includes("does not take --project") && r.stderr.includes("vibest update"),
          `run --project: ${r.code} ${r.stdout}${r.stderr}`,
        )
        const started = s.bDb<{ n: number }>("SELECT count(*) AS n FROM session")?.n
        expect(started === 0, `B has ${started} sessions`)
      } finally {
        await s?.stop()
      }
    },
  },
]

export default checks
