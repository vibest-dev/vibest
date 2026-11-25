import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask } from "../fake-model.ts"
import { binary, checkout, expect, harnesses, until, type World } from "../world.ts"
import { fakeSsh, setup, sh, stopVibestd, type Setup } from "./machines.ts"

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

const disableCapability = (bytes: Buffer, name: string) => {
  const from = `${name}: true`
  const to = `${name}: !1  `
  const at = bytes.indexOf(from)
  expect(at >= 0 && bytes.indexOf(from, at + 1) < 0, `cannot patch capability ${name}`)
  bytes.write(to, at)
}

const beforeRepositoryLists = async (w: World) => {
  const dir = path.join(w.root, `before-repo-lists-${crypto.randomUUID().slice(0, 8)}`)
  const bin = path.join(dir, "bin", "vibest")
  await fs.mkdir(path.dirname(bin), { recursive: true })

  const built = await w.run(path.join(checkout, "packages", "cli"), [
    process.execPath,
    "scripts/build.ts",
    bin,
    `bun-${process.platform}-${process.arch}`,
    "--no-bytecode",
  ])

  expect(built.code === 0, `beforeRepositoryLists build exited ${built.code}: ${built.stdout}${built.stderr}`)
  const bytes = Buffer.from(await fs.readFile(bin))
  disableCapability(bytes, "remoteSpawnRepositories")
  disableCapability(bytes, "remoteSpawnProject")
  disableCapability(bytes, "projectClone")
  await fs.writeFile(bin, bytes, { mode: 0o755 })

  if (process.platform === "darwin") {
    const signed = await w.run(dir, ["codesign", "--force", "-s", "-", bin])
    expect(signed.code === 0, `codesign: ${signed.stdout}${signed.stderr}`)
  }

  await fs.cp(harnesses, path.join(dir, "harnesses"), { recursive: true })

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
        const id8 = await s.run("mtworepos")
        await until("the message on A", () => s!.notices(id8, "mtworepos") === 1, 120_000)

        const inCombo = async (args: ReadonlyArray<string>) => {
          const r = await w.run(a.combo, [binary, ...args], { env: s!.aEnv })
          expect(r.code === 0, `A: vibest ${args.join(" ")} in ${a.combo}: ${r.stderr}${r.stdout}`)

          return r.stdout
        }

        const got = JSON.parse(await inCombo(["result", id8, "--machine", "mb"])) as { worktree: string }
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

        await inCombo(["archive", id8, "--machine", "mb"])
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M12",
    title:
      "a project of two repositories and a B running an unmodified vibest built from before repository lists: run --machine is refused on A with run vibest update on mb, and B starts nothing",
    run: async (w) => {
      let s: Setup | undefined

      try {
        const oldBin = await beforeRepositoryLists(w)
        const a = await twoRepositories(w)
        s = await setup(w, { aProject: a.combo })
        await s.okA(["machine", "add", "mb", "b-host"])

        await stopVibestd(s.bEnv.VIBEST_HOME)

        for (const file of ["vibest.db", "vibest.db-wal", "vibest.db-shm"])
          await fs.rm(path.join(s.bEnv.VIBEST_HOME, file), { force: true })

        const oldBEnv = { ...s.bEnv, PATH: `${path.dirname(oldBin)}:${s.bEnv.PATH}` }

        const exports = Object.entries(oldBEnv)
          .flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${sh(v)}`]))
          .join(" ")

        const empty = path.join(w.root, "empty-zdotdir")
        await fs.writeFile(path.join(w.root, "bin", "ssh"), fakeSsh(w.root, exports, empty), { mode: 0o755 })

        const addedOld = await w.run(path.join(s.b, "shop"), [oldBin, "project", "add"], { env: oldBEnv })
        expect(addedOld.code === 0, `old B project add: ${addedOld.stderr}${addedOld.stdout}`)

        await until(
          "mb reconnected",
          async () =>
            (JSON.parse(await s!.okA(["machine", "ls"])) as Array<{ state: string }>)[0]?.state === "connected",
          30_000,
        )

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

        expect(chosen.machine === "mb", `run --machine --project: ${JSON.stringify(chosen)}`)
        const id8 = chosen.id.slice(0, 8)

        await until("the message on A", () => s!.notices(id8, "mchosen") === 1, 120_000)
        const got = JSON.parse(await s.okA(["result", id8, "--machine", "mb"])) as { worktree: string }
        const common = await git(w, got.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
        expect(
          common === path.join(await fs.realpath(second), ".git"),
          `the session on B runs in ${got.worktree} of ${common}`,
        )
        await s.okA(["archive", id8, "--machine", "mb"])
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
      const oldHome = path.join(w.root, "old-a-home")

      try {
        const oldBin = await beforeRepositoryLists(w)
        s = await setup(w)
        await s.okA(["machine", "add", "mb", "b-host"])

        await fs.mkdir(oldHome, { recursive: true })

        const startedOld = await w.run(w.repository, [oldBin, "daemon"], {
          env: { ...s.aEnv, VIBEST_HOME: oldHome },
        })

        expect(startedOld.code === 0, `old A daemon: ${startedOld.stderr}${startedOld.stdout}`)

        const r = await w.run(
          w.repository,
          [binary, "run", "--machine", "mb", "--project", "elsewhere", "pi", "--", "say hello"],
          {
            env: { ...s.aEnv, VIBEST_HOME: oldHome, VIBEST_SESSION_ID: crypto.randomUUID() },
          },
        )

        expect(r.code !== 0 && r.stderr.includes("vibest update"), `run --project: ${r.code} ${r.stdout}${r.stderr}`)
        const started = s.bDb<{ n: number }>("SELECT count(*) AS n FROM session")?.n
        expect(started === 0, `B has ${started} sessions`)
      } finally {
        await stopVibestd(oldHome)
        await s?.stop()
      }
    },
  },
]

export default checks
