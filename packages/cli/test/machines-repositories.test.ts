import { assert, describe, it } from "@effect/vitest"
import { caseFoldedWorktrees } from "@vibest/core/paths"
import { FakeGit, tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import {
  COMMIT,
  entryOn,
  REMOTE,
  REPOSITORY,
  repoStack,
  twoMachines,
} from "@vibest/platform-bun/test/lib/machines-fakes"
import { randomId } from "@vibest/schema/id"
import { Effect, FileSystem } from "effect"

import * as Platform from "#platform"

describe("Peer.Spawn for a project of several repositories", () => {
  it.effect(
    "Peer.Spawn with a repository list: the one project of exactly those repositories, worktrees under A's folder names; a missing repository, a missing commit and two such projects are refused",
    () =>
      Effect.gen(function* () {
        const b = yield* repoStack()
        const call = yield* b.as(randomId(), "aproj")
        const git = yield* b.run(FakeGit)
        const x = "https://example.com/o/x"
        const y = "https://example.com/o/y"

        const project = (name: string) =>
          Effect.gen(function* () {
            const dir = yield* tempDirectory(`vibest-b-${name}-`)
            const paths = [`${dir}/one`, `${dir}/two`] as const
            yield* git.repository(paths[0], { ...REPOSITORY, origin: x })
            yield* git.repository(paths[1], { ...REPOSITORY, origin: y })

            yield* b.db.project.createProject(dir, [
              { path: paths[0], remote: x },
              { path: paths[1], remote: y },
            ])

            return { dir, paths }
          })

        const spawn = (repositories: ReadonlyArray<{ folder: string; repository: string; commit: string }>) =>
          call(b.raw["Peer.Spawn"]({ agent: "general", repositories, prompt: "x", request: randomId() }))

        const wanted = [
          { folder: "y", repository: y, commit: COMMIT },
          { folder: "x", repository: x, commit: COMMIT },
        ]

        const first = yield* project("first")
        const spawned = yield* spawn(wanted)
        assert.strictEqual(spawned.directory, first.dir)
        assert.deepStrictEqual(b.spawns.at(-1)!.folders, [
          { name: "y", path: first.paths[1], commit: COMMIT },
          { name: "x", path: first.paths[0], commit: COMMIT },
        ])
        assert.isUndefined(b.spawns.at(-1)!.commit)

        const lacking = yield* Effect.flip(
          spawn([...wanted, { folder: "z", repository: "https://example.com/o/z", commit: COMMIT }]),
        )

        assert.strictEqual(lacking._tag, "NoProject")
        assert.include(lacking.message, "has no checkout of https://example.com/o/z")
        assert.include(lacking.message, "vibest project add")

        const noCommit = yield* Effect.flip(spawn([wanted[0]!, { ...wanted[1]!, commit: "fedcba9" }]))
        assert.strictEqual(noCommit._tag, "NoCommit")
        assert.include(noCommit.message, `${first.paths[0]} does not have fedcba9: push it and fetch it there`)

        const second = yield* project("second")
        const several = yield* Effect.flip(spawn(wanted))
        assert.strictEqual(several._tag, "NoProject")
        assert.include(several.message, `several projects for ${y}, ${x}: ${first.dir}, ${second.dir}`)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "B pairs exact URLs before identity matches, ignores other projects' URL spellings, and refuses folder names that collide on its file system",
    () =>
      Effect.gen(function* () {
        const x = "https://host/o/x"
        const y = "https://host/o/y"

        const attempt = (mode: "scope" | "greedy" | "case", urls: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const b = yield* repoStack(undefined, {}, mode === "scope" ? x : "https://other/o/s")
            const git = yield* b.run(FakeGit)
            const root = yield* tempDirectory("vibest-b-pair-")
            const rows = urls.map((remote, i) => ({ path: `${root}/r${i}`, remote }))

            for (const row of rows) yield* git.repository(row.path, { ...REPOSITORY, origin: row.remote })
            yield* b.db.project.createProject(root, rows)
            const call = yield* b.as(randomId(), "aproj")

            const entry = (folder: string, repository: string, identity: string) => ({
              folder,
              repository,
              identity,
              commit: COMMIT,
            })

            const repositories =
              mode === "greedy"
                ? [entry("a", "https://HOST/o/x", "host/o/x"), entry("b", x, "host/o/x")]
                : [
                    entry(mode === "case" ? "Tools" : "a", x, "host/o/x"),
                    entry(mode === "case" ? "tools" : "b", y, "host/o/y"),
                  ]

            const out = yield* Effect.result(
              call(b.raw["Peer.Spawn"]({ agent: "general", prompt: "x", request: randomId(), repositories })),
            )

            return { out, spawns: b.spawns, root }
          })

        const scope = yield* attempt("scope", [`${x}.git`, y])
        assert.strictEqual(scope.out._tag, "Success")
        assert.strictEqual(scope.spawns.at(-1)!.root, scope.root)

        const greedy = yield* attempt("greedy", [x, `${x}.git`])
        assert.strictEqual(greedy.out._tag, "Success")
        assert.deepStrictEqual(
          greedy.spawns.at(-1)!.folders?.map((f) => [f.name, f.path]),
          [
            ["a", `${greedy.root}/r1`],
            ["b", `${greedy.root}/r0`],
          ],
        )

        const folded = yield* attempt("case", [x, y])
        assert.strictEqual(folded.out._tag, caseFoldedWorktrees ? "Failure" : "Success")
        assert.lengthOf(folded.spawns, caseFoldedWorktrees ? 0 : 1)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a single-repository request: refused when several projects hold the repository, even one of several repositories; run at A's commit inside a project folder that holds only that checkout",
    () =>
      Effect.gen(function* () {
        const x = "https://host/o/x"

        const parentProject = (b: Effect.Success<ReturnType<typeof repoStack>>, others: ReadonlyArray<string> = []) =>
          Effect.gen(function* () {
            const parent = yield* tempDirectory("vibest-b-parent-")
            const child = `${parent}/r`
            const rows = [x, ...others].map((remote, i) => ({ path: i === 0 ? child : `${parent}/o${i}`, remote }))
            const git = yield* b.run(FakeGit)

            for (const row of rows) yield* git.repository(row.path, { ...REPOSITORY, origin: row.remote })
            yield* b.db.project.createProject(parent, rows)
            const call = yield* b.as(randomId(), "aproj")

            const spawn = call(
              b.raw["Peer.Spawn"]({
                agent: "general",
                prompt: "x",
                request: randomId(),
                repository: x,
                commit: COMMIT,
              }),
            )

            return { parent, child, spawn }
          })

        const both = yield* repoStack(undefined, {}, x)
        const ambiguous = yield* parentProject(both, ["https://host/o/y"])
        const several = yield* Effect.flip(ambiguous.spawn)
        assert.strictEqual(several._tag, "NoProject")
        assert.include(several.message, `several projects for ${x}: ${both.directory}, ${ambiguous.parent}`)
        assert.lengthOf(both.spawns, 0)

        const b = yield* repoStack(undefined, {}, "https://other/o/s")
        const only = yield* parentProject(b)
        yield* only.spawn
        assert.strictEqual(b.spawns.at(-1)!.root, only.parent)
        assert.deepStrictEqual(b.spawns.at(-1)!.folders, [{ name: "r", path: only.child, commit: COMMIT }])
        assert.isUndefined(b.spawns.at(-1)!.commit)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "A reads the project folder at each run: a repository cloned beside a running project's checkout is sent, so B lacking it refuses and starts nothing",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoMachines()
        const fs = yield* FileSystem.FileSystem
        const root = yield* tempDirectory("vibest-a-grow-")
        const git = yield* a.run(FakeGit)

        const add = (name: string, origin: string) =>
          Effect.gen(function* () {
            const path = `${root}/${name}`
            yield* fs.makeDirectory(path)
            yield* git.repository(path, { ...REPOSITORY, origin })

            return { path, remote: origin }
          })

        const project = yield* a.db.project.createProject(root, [yield* add("r", REMOTE)])
        const { asEntry } = yield* entryOn({ ...a, project, directory: root })
        yield* add("s", "https://host/o/s")

        const refused = yield* Effect.flip(
          asEntry(a.raw.Spawn({ agent: "general", machine: "mb", prompt: "x", callerEnv: {} })),
        )

        assert.include(refused.message, "has no checkout of https://host/o/s")
        assert.lengthOf(b.spawns, 0)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
