import fs from "node:fs"
import os from "node:os"

import { afterAll, assert, describe, it } from "@effect/vitest"
import { runtimeContract } from "@vibest/plugin/testing"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { ConfigProvider, Effect, Option } from "effect"

import { herdrOnPath, started, stopSession, layer, waitFor, withSession, withRuntime } from "./runtime-herdr-live.ts"

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(async () => {
    for (const name of started) await stopSession(name)
  })

  it.live(
    "the terminal runtime passes the shared contract suite (runtime-port.md §3)",
    () =>
      withSession(({ socketPath }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const cwd = fs.realpathSync(os.tmpdir())
            yield* runtimeContract(runtime, { cwd, timeout: "20 seconds" }).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))),
            )
          }),
        ),
      ).pipe(Effect.provide(layer)),
    120_000,
  )

  it.live(
    "open types argv into the pane's shell, and read, send, process, present and close land on herdr",
    () =>
      withSession(({ name, socketPath }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const cwd = fs.realpathSync(os.tmpdir())
            const env = { HERDR_SOCKET_PATH: socketPath }
            const opened = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["printf", "VBT_%s\\n", "TYPED"],
                  env: {},
                  label: "vibest test",
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const seen = TerminalRuntime.parseTerminal(opened)
            assert.isDefined(seen)
            assert.strictEqual(seen!.session, name)
            yield* waitFor(runtime.read(opened, 40), (value) => value.includes("VBT_TYPED"), "the typed argv ran")
            yield* runtime.send(opened, { text: "printf 'VBT_%s\\n' OPENED", keys: ["enter"] })
            const text = yield* waitFor(runtime.read(opened, 40), (value) => value.includes("VBT_OPENED"), "pane text")
            assert.include(text, "VBT_OPENED")
            if (runtime.state !== undefined) {
              const failed = yield* runtime.state(opened).pipe(Effect.flip, Effect.option)
              assert.isTrue(
                Option.isSome(failed) && Option.getOrThrow(failed).code === "not_found",
                "open started no agent, so state finds none of this terminal's",
              )
            }
            yield* runtime.send(opened, { text: "sleep 2", keys: ["enter"] })
            yield* waitFor(runtime.process(opened), (p) => p.running, "foreground program")
            yield* runtime.send(opened, { keys: ["enter"] })
            yield* waitFor(runtime.process(opened), (p) => !p.running, "shell again")
            if (runtime.present !== undefined)
              yield* runtime.present(opened, {
                agent: "general",
                harness: "pi",
                title: "task",
                definition: "general",
                session: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
                project: "repo",
                live: "2",
              })
            const herdr = yield* (yield* HerdrPool).client(name)
            const pane = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
            assert.strictEqual(pane.display_agent, "general \u00b7 pi")
            assert.strictEqual(pane.title, "task")
            assert.strictEqual(pane.tokens?.definition, "general")
            assert.strictEqual(pane.tokens?.session, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
            assert.strictEqual(pane.state_labels?.blocked, "waiting for you")
            const workspace = (yield* herdr.call("workspace.list", {})).workspaces.find(
              (item) => item.workspace_id === pane.workspace_id,
            )
            assert.strictEqual(workspace?.tokens?.project, "repo")
            assert.strictEqual(workspace?.tokens?.agents, "2")
            if (runtime.present !== undefined) {
              yield* runtime.present(opened, {
                agent: "g".repeat(90),
                harness: "pi",
                title: "n".repeat(90),
                definition: "g".repeat(90),
              })
              const limited = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
              assert.strictEqual(limited.display_agent?.length, 80)
              assert.strictEqual(limited.title?.length, 80)
              assert.strictEqual(limited.tokens?.definition?.length, 80)
              yield* runtime.present(opened, { agent: "reviewer", harness: "pi", title: "later" })
              const again = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
              assert.strictEqual(again.display_agent, "reviewer \u00b7 pi")
              assert.strictEqual(
                again.title,
                "later",
                "a present right after another lands: each report's seq is newer",
              )
            }
            const before = (yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id)
            const beside = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["/bin/sh"],
                  env: { VBT_NEAR: "1" },
                  label: "beside",
                  near: opened,
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const besidePane = (yield* herdr.call("pane.get", {
              pane_id: TerminalRuntime.parseTerminal(beside)!.paneId,
            })).pane
            assert.strictEqual(besidePane.workspace_id, pane.workspace_id)
            assert.deepStrictEqual(
              (yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id),
              before,
            )
            const tab = (yield* herdr.call("tab.list", { workspace_id: besidePane.workspace_id })).tabs.find(
              (item) => item.tab_id === besidePane.tab_id,
            )
            assert.strictEqual(tab?.label, "beside")
            assert.strictEqual(tab?.focused, false, "near opens an unfocused tab in that pane's workspace")
            yield* runtime.close(beside).pipe(Effect.ignore)
            const grouped = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["/bin/sh"],
                  env: {},
                  label: "grouped",
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const groupedPane = (yield* herdr.call("pane.get", {
              pane_id: TerminalRuntime.parseTerminal(grouped)!.paneId,
            })).pane
            assert.strictEqual(
              groupedPane.workspace_id,
              pane.workspace_id,
              "the same project without near reuses the workspace a pane at its directory names",
            )
            yield* runtime.close(grouped).pipe(Effect.ignore)
          }),
        ),
      ).pipe(Effect.provide(layer)),
    90_000,
  )
})
