import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask } from "../fake-model.ts"
import { binary, compiled, expect, harnesses, until, type World } from "../world.ts"
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

const withoutRepositoryList = async (w: World) => {
  const dir = path.join(w.root, "older-b")
  const bin = path.join(dir, "bin", "vibest")
  await fs.mkdir(path.dirname(bin), { recursive: true })
  const bytes = Buffer.from(await fs.readFile(compiled))
  const from = "peerSpawnRepositories: true"
  const at = bytes.indexOf(from)
  expect(at >= 0 && bytes.indexOf(from, at + 1) < 0, `${compiled} has not exactly one ${from}`)
  bytes.write("peerSpawnRepositorieX: true", at)
  await fs.writeFile(bin, bytes, { mode: 0o755 })

  if (process.platform === "darwin") {
    const signed = await w.run(dir, ["codesign", "--force", "-s", "-", bin])
    expect(signed.code === 0, `codesign: ${signed.stderr}`)
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
      "a project of two repositories and a B whose vibest does not take a repository list: run --machine is refused on A with run vibest update on B, and B starts nothing",
    run: async (w) => {
      let s: Setup | undefined

      try {
        const a = await twoRepositories(w)
        s = await setup(w, { aProject: a.combo, bBinary: await withoutRepositoryList(w) })
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

        const address = (
          JSON.parse(
            await w.okViaEntry(["run", "--machine", "mb", "--project", "shop-two", "pi", "--", ask("mchosen")], {
              env: s.aEnv,
              asIs: true,
            }),
          ) as { id: string }
        ).id.slice(0, "mb/".length + 8)

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
]

export default checks
