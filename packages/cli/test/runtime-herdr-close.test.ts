import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "@effect/vitest"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { ConfigProvider, Effect, Exit, Ref, Stream } from "effect"

import {
  herdrOnPath,
  stopStartedSessions,
  layer,
  waitFor,
  withSession,
  withRuntime,
  git,
} from "./runtime-herdr-live.ts"

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(() => stopStartedSessions(), 30_000)

  it.live(
    "close moves the last pane of a main checkout's workspace out before closing it: the linked worktree's pane survives; a worktree-less workspace closes directly, at most itself",
    () =>
      withSession(({ name, socketPath }) =>
        withRuntime((runtime) => {
          const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
          const open = (cwd: string) =>
            runtime
              .open({ id: "local" }, { project: cwd, cwd, argv: ["/bin/sh"], env: {}, label: "close test" })
              .pipe(Effect.provide(env))
          return Effect.gen(function* () {
            const log = yield* Ref.make<ReadonlyArray<TerminalRuntime.RuntimeEvent>>([])
            yield* (runtime.events ?? Stream.empty).pipe(
              Stream.runForEach((event) => Ref.update(log, (events) => [...events, event])),
              Effect.forkScoped,
              Effect.ignore,
            )
            const herdr = yield* (yield* HerdrPool).client(name)
            const workspaces = () => herdr.call("workspace.list", {}).pipe(Effect.map((r) => r.workspaces))

            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibest-close-")))
            const repo = path.join(dir, "repo")
            fs.mkdirSync(repo)
            git(dir, "init", "-q", repo)
            git(repo, "-c", "user.email=v@v", "-c", "user.name=v", "commit", "-q", "--allow-empty", "-m", "x")
            git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "linked"))
            const main = yield* open(repo)
            const mainPane = TerminalRuntime.parseTerminal(main)!.paneId
            const linked = yield* herdr.call("worktree.open", {
              cwd: repo,
              path: path.join(dir, "linked"),
              trust_repository: true,
            })
            const linkedPane = linked.root_pane.pane_id
            yield* runtime.close(main)
            assert.isTrue(Exit.isFailure(yield* Effect.exit(herdr.call("pane.get", { pane_id: mainPane }))))
            assert.strictEqual((yield* herdr.call("pane.get", { pane_id: linkedPane })).pane.pane_id, linkedPane)
            assert.isTrue((yield* workspaces()).some((w) => w.workspace_id === linked.workspace.workspace_id))

            const plain = path.join(dir, "plain")
            fs.mkdirSync(plain)
            const first = yield* open(plain)
            const second = yield* open(plain)
            const ws = (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(first)!.paneId })).pane
              .workspace_id
            yield* runtime.close(first)
            assert.strictEqual(
              (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId })).pane
                .workspace_id,
              ws,
            )
            yield* runtime.close(second)
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId })),
              ),
            )
            yield* waitFor(
              Ref.get(log),
              (events) => events.some((event) => event.type === "exited" && event.terminal.id === second.id),
              "closed in place: gone under its own id, which a move would have changed",
            )
          })
        }),
      ).pipe(Effect.provide(layer)),
    90_000,
  )
})
