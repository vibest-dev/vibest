import fs from "node:fs"
import os from "node:os"

import { afterAll, assert, describe, it } from "@effect/vitest"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, Exit } from "effect"

import {
  herdrOnPath,
  piOnPath,
  barePiArgv,
  coldPiStartupAttempts,
  stopStartedSessions,
  layer,
  waitFor,
  withSession,
  withRuntime,
} from "./runtime-herdr-live.ts"

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(() => stopStartedSessions(), 30_000)

  it.live.skipIf(!piOnPath)(
    "the main agent in place, a harness a shell ran that herdr detected and no open named, is still ours: state reads it, and send submits (Enter included)",
    () =>
      withSession(({ name }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const herdr = yield* (yield* HerdrPool).client(name)
            const cwd = fs.realpathSync(os.tmpdir())
            const made = yield* herdr.call("workspace.create", { cwd, label: "detected", focus: false })
            const paneId = made.root_pane.pane_id
            yield* Effect.gen(function* () {
              yield* herdr.call("pane.wait_for_output", {
                pane_id: paneId,
                source: "visible",
                match: { type: "regex", value: "\\S" },
                timeout_ms: 60_000,
              })
              yield* herdr.call("pane.send_text", { pane_id: paneId, text: barePiArgv.join(" ") })
              yield* herdr.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
              yield* waitFor(
                herdr.call("agent.get", { target: paneId }).pipe(Effect.exit),
                Exit.isSuccess,
                "herdr detected the agent",
                coldPiStartupAttempts,
              )
              const terminal = TerminalRuntime.terminalOf(name, paneId)
              if (runtime.state !== undefined)
                yield* waitFor(
                  runtime.state(terminal),
                  (state) => state === "idle",
                  "the detected agent idle",
                  coldPiStartupAttempts,
                )
              yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' SUBMITS" })
              yield* waitFor(
                runtime.read(terminal, 80),
                (text) => text.includes("VBT_SUBMITS"),
                "the submitted prompt ran, printing VBT_SUBMITS that the typed text does not contain",
                coldPiStartupAttempts,
              )
              const oldTerminal = TerminalRuntime.terminalOf(name, paneId, "vbt-gone-00000000")
              if (runtime.state !== undefined)
                assert.strictEqual((yield* Effect.flip(runtime.state(oldTerminal))).code, "not_found")
              assert.strictEqual((yield* Effect.flip(runtime.close(oldTerminal))).code, "failed")
              assert.isTrue(Exit.isSuccess(yield* Effect.exit(herdr.call("pane.get", { pane_id: paneId }))))
            }).pipe(
              Effect.ensuring(
                herdr.call("workspace.close", { workspace_id: made.workspace.workspace_id }).pipe(Effect.ignore),
              ),
            )
          }),
        ),
      ).pipe(Effect.provide(layer)),
    400_000,
  )
})
