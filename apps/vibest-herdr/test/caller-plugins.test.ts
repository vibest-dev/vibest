import { assert, describe, it } from "@effect/vitest"
import { callerHits } from "@vibest/core/caller"
import type { Candidate } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

import { mainPlace } from "../src/cli.ts"

const runtime = (kind: string, priority: number, env: ReadonlyArray<string>): Candidate => ({
  source: kind,
  revision: "-",
  options: {},
  plugin: Plugin.define({
    id: `runtime-${kind}`,
    caller: {
      kind,
      env,
      priority,
      terminal: (values) => Effect.succeed(env.map((key) => values[key]).join("/")),
    },
    effect: () => Effect.void,
  }),
})

const plugins = [
  runtime("hc", 0, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]),
  runtime("herdr", 1, ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"]),
  runtime("rex", -1, ["REX_PANE"]),
]

describe("caller plugins", () => {
  it.effect("a third runtime plugin is selected by the priority it declares", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, {
        REX_PANE: "rex-9",
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "rex",
        terminal: "rex-9",
      })
    }),
  )

  it.effect("without that plugin's environment the next declared priority wins", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, {
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "t1//hc.sock",
      })
    }),
  )

  it.effect("an empty declared variable is not that runtime", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, { REX_PANE: "", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/hc.sock" })
      assert.strictEqual(mainPlace({ marked: false, runtime: undefined, hits }).in === "terminal", true)
      const place = mainPlace({ marked: false, runtime: undefined, hits })
      assert.strictEqual(place.in === "terminal" ? place.runtime : "", "hc")
    }),
  )
})
