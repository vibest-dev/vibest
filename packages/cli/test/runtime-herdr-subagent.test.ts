import fs from "node:fs"
import os from "node:os"

import { afterAll, assert, describe, it } from "@effect/vitest"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { ConfigProvider, Effect } from "effect"

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

const promptAttempts = 100
const promptRounds = 12

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(() => stopStartedSessions(), 30_000)

  it.live.skipIf(!piOnPath)(
    "every subagent's way: open starts a harness as a named agent that state reads and send prompts, whatever its pane id (past p9 herdr's ids carry uppercase)",
    () =>
      withSession(({ socketPath }) =>
        withRuntime((runtime) => {
          const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
          const cwd = fs.realpathSync(os.tmpdir())
          const open = (argv: ReadonlyArray<string>, vars: Record<string, string> = {}) =>
            runtime.open({ project: cwd, cwd, argv, env: vars, label: "harness" }).pipe(Effect.provide(env))
          return Effect.gen(function* () {
            const shellsPastP9 = 10
            for (let i = 0; i < shellsPastP9; i++) yield* open(["/bin/sh"])
            const terminal = yield* open(barePiArgv, {
              VIBEST_SESSION_ID: "ab12cd34-5678-4abc-8def-0123456789ab",
            })
            assert.strictEqual(
              TerminalRuntime.parseTerminal(terminal)?.name,
              "s-ab12cd3456784abc8def0123456789",
              "named after the vibest session, so herdr agent list shows which session runs where",
            )
            if (runtime.state !== undefined)
              yield* waitFor(
                runtime.state(terminal),
                (state) => state === "idle",
                "the started agent idle",
                coldPiStartupAttempts,
              )
            const ran = runtime.read(terminal, 80).pipe(Effect.map((text) => text.includes("VBT_STARTED")))
            const promptRuns = Effect.gen(function* () {
              yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' STARTED" })
              return yield* waitFor(ran, (seen) => seen, "the prompt ran", promptAttempts).pipe(
                Effect.catchDefect(() => Effect.succeed(false)),
              )
            })
            for (let round = 0; round < promptRounds; round++) if (yield* promptRuns) return
            return yield* Effect.die(new Error(`the prompt did not run in ${promptRounds} sends`))
          })
        }),
      ).pipe(Effect.provide(layer)),
    400_000,
  )
})
