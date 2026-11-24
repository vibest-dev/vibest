import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { listProjectRepositories, projectRepositories, workspaceGit } from "@vibest/core/project/create"
import { Session } from "@vibest/core/session"
import { Effect, FileSystem, Layer, Path } from "effect"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf, tempDirectory } from "./lib/directory.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { fakeGit } from "./lib/layers.ts"
import { sessionLayer } from "./lib/session.ts"

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

describe("Session.list and workspaceGit bounded concurrency", () => {
  it.effect("workspaceGit skips currentBranch and preserves sorted repo order and git states", () =>
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
      assert.strictEqual(currentBranchCalls, 10)
      assert.deepStrictEqual(
        listed!.map((r) => [r.name, r.branch]),
        names.map((name) => [name, name === "repo-04" ? "" : `branch-${name}`]),
      )

      const places = yield* projectRepositories(workspace).pipe(Effect.provideService(Git.Service, trackedGit))
      assert.strictEqual(places.length, 10)
    }).pipe(Effect.provide(sessionLayer())),
  )

  it.effect("Session.list inspects multi-repo sessions concurrently within bounds and preserves row order", () => {
    let stateInFlight = 0
    let maxStateInFlight = 0

    const wrappedGit = Git.node.replace(
      LayerNode.make({
        service: Git.Service,
        layer: Layer.effect(
          Git.Service,
          Effect.map(FakeGit, (fg) =>
            Git.Service.of({
              ...fg.git,
              state: (dir) =>
                Effect.gen(function* () {
                  maxStateInFlight = Math.max(maxStateInFlight, ++stateInFlight)

                  return yield* TestClock.withLive(Effect.sleep("5 millis")).pipe(
                    Effect.andThen(fg.git.state(dir)),
                    Effect.ensuring(Effect.sync(() => void stateInFlight--)),
                  )
                }),
            }),
          ),
        ),
        deps: [fakeGit],
      }),
    )

    return Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const names = Array.from({ length: 10 }, (_, i) => `repo-${String(i).padStart(2, "0")}`)
      const workspace = yield* makeMultiRepoWorkspace(names)
      const project = yield* projectOf(workspace)

      for (let i = 0; i < 6; i++) {
        const id = `00000000-0000-4000-8000-00000000000${i}`
        yield* db.session.insertSession(
          {
            id,
            agent: "general",
            harnessId: "pi",
            harnessSessionId: null,
            name: `session-${i}`,
            runtime: RUNTIME,
            address: { machine: "local", id: `t/${i}` },
            status: "idle",
            startedAt: 1000 + i,
            createdAt: 1000 + i,
            lastActive: 1000 + i,
            executionState: "completed",
            executionPromptedAt: 1000 + i,
            provider: null,
            model: null,
            exitedAt: null,
          },
          project,
          { cwd: workspace },
        )
      }

      const rawRows = yield* db.session.listSessions({})
      const views = yield* sessions.list({})

      assert.deepStrictEqual(
        views.map((v) => v.id),
        rawRows.map((r) => r.id),
      )
      assert.strictEqual(views.length, 6)
      assert.isAbove(maxStateInFlight, 1)

      for (const view of views) {
        assert.strictEqual(view.worktree, workspace)
        assert.strictEqual(view.repositoryRoot, workspace)
        assert.strictEqual(view.git?.saved, false)
        assert.strictEqual(view.git?.why, "repo-03: uncommitted changes")
        assert.strictEqual(view.git?.pushed, false)
      }
    }).pipe(Effect.provide(sessionLayer([wrappedGit])))
  })
})
