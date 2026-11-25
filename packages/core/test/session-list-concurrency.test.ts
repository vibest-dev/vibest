import { assert, describe, it } from "@effect/vitest"
import { listProjectRepositories, projectRepositories, workspaceGit } from "@vibest/core/project/create"
import { Git } from "@vibest/core/worktree/git"
import { tempDirectory } from "@vibest/testkit/directory"
import { FakeGit } from "@vibest/testkit/fake-git"
import { sessionLayer } from "@vibest/testkit/session"
import { Effect, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"

const makeMultiRepoWorkspace = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* FakeGit
    const root = yield* tempDirectory("vibest-multi-repo-")

    for (const name of names) {
      const dir = path.join(root, name)
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* git.repository(dir, {
        branch: `branch-${name}`,
        files: { "README.md": `${name}\n` },
      })
    }

    yield* git.checkout(path.join(root, "repo-00"), {
      branch: "branch-repo-00",
      state: { branch: "branch-repo-00", pushed: true, saved: true, why: "" },
    })
    yield* git.checkout(path.join(root, "repo-02"), {
      branch: "branch-repo-02",
      state: { branch: "branch-repo-02", pushed: false, saved: true, why: "" },
    })
    yield* git.checkout(path.join(root, "repo-03"), {
      branch: "branch-repo-03",
      state: { branch: "branch-repo-03", pushed: false, saved: false, why: "uncommitted changes" },
    })
    yield* git.checkout(path.join(root, "repo-04"), {
      branch: "",
      state: { branch: "", pushed: false, saved: false, why: "commits not on any branch" },
    })

    return root
  })

describe("workspaceGit and project repository bounded concurrency", () => {
  it.effect(
    "listProjectRepositories and workspaceGit skip currentBranch and preserve sorted order and git states",
    () =>
      Effect.gen(function* () {
        const names = Array.from({ length: 10 }, (_, i) => `repo-${String(i).padStart(2, "0")}`)
        const workspace = yield* makeMultiRepoWorkspace(names.toReversed())
        const baseGit = yield* Git.Service
        let currentBranchCalls = 0
        let stateInFlight = 0
        let maxStateInFlight = 0

        const trackedGit: Git.Interface = {
          ...baseGit,
          currentBranch: (dir) => {
            currentBranchCalls++

            return baseGit.currentBranch(dir)
          },
          state: (dir) =>
            Effect.gen(function* () {
              maxStateInFlight = Math.max(maxStateInFlight, ++stateInFlight)

              return yield* TestClock.withLive(Effect.sleep("5 millis")).pipe(
                Effect.andThen(baseGit.state(dir)),
                Effect.ensuring(Effect.sync(() => void stateInFlight--)),
              )
            }),
        }

        const repos = yield* workspaceGit(workspace).pipe(Effect.provideService(Git.Service, trackedGit))
        assert.isDefined(repos)
        assert.strictEqual(currentBranchCalls, 0)
        assert.isAbove(maxStateInFlight, 1)
        assert.isAtMost(maxStateInFlight, 8)
        assert.deepStrictEqual(
          repos!.map((r) => r.name),
          names,
        )

        const byName = new Map(repos!.map((r) => [r.name, r]))
        assert.deepInclude(byName.get("repo-00"), { branch: "branch-repo-00", pushed: true, saved: true, why: "" })
        assert.deepInclude(byName.get("repo-02"), { branch: "branch-repo-02", pushed: false, saved: true, why: "" })
        assert.deepInclude(byName.get("repo-03"), {
          branch: "branch-repo-03",
          saved: false,
          why: "uncommitted changes",
        })
        assert.deepInclude(byName.get("repo-04"), {
          branch: "",
          pushed: false,
          saved: false,
          why: "commits not on any branch",
        })

        const listed = yield* listProjectRepositories(workspace).pipe(Effect.provideService(Git.Service, trackedGit))
        assert.isDefined(listed)
        assert.strictEqual(currentBranchCalls, 0)
        assert.deepStrictEqual(
          listed!.map((r) => r.name),
          names,
        )

        const places = yield* projectRepositories(workspace).pipe(Effect.provideService(Git.Service, trackedGit))
        assert.strictEqual(places.length, 10)
      }).pipe(Effect.provide(sessionLayer())),
  )
})
