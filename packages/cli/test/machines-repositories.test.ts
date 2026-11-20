import { assert, describe, it } from "@effect/vitest"
import { FakeGit, tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { COMMIT, REPOSITORY, repoStack } from "@vibest/platform-bun/test/lib/machines-fakes"
import { randomId } from "@vibest/schema/id"
import { Effect } from "effect"

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
})
