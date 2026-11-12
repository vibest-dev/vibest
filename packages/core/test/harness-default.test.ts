import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { harnessDefaultPlugin } from "../../builtins/src/harness-default.ts"
import { Agents } from "../src/agents.ts"
import { Bus } from "../src/bus.ts"
import { Plugins } from "../src/plugins.ts"
import { harnessesLayer, runtimesLayer, subscriptionsLayer } from "./lib/harnesses.ts"

const event = (harness: string | undefined, claude: boolean) => ({
  project: "/r",
  agent: "general",
  parentSessionId: undefined,
  prompt: "",
  harness,
  provider: undefined,
  model: undefined,
  machine: { id: "local" },
  runtime: undefined,
  parentRuntime: undefined,
  machines: [],
  attempts: [],
  subscriptions: [],
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: claude },
  ],
})

const chosen = (harness: string | undefined, claude: boolean) =>
  Plugins.make([
    { source: "builtin:harness-default", revision: "1", options: {}, plugin: harnessDefaultPlugin() },
  ]).pipe(
    Effect.flatMap((plugins) => plugins.start(event(harness, claude))),
    Effect.map((decision) => decision.harness),
    Effect.provide(subscriptionsLayer),
    Effect.provide(harnessesLayer()),
    Effect.provide(runtimesLayer),
    Effect.provide(Agents.layer),
    Effect.provide(Bus.layer),
    Effect.provide(Agents.layer),
    Effect.scoped,
  )

describe("harness-default", () => {
  it.effect("chooses claude only when the harness is unset and claude is available", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* chosen(undefined, true), "claude")
      assert.strictEqual(yield* chosen("pi", true), "pi")
      assert.strictEqual(yield* chosen(undefined, false), undefined)
    }),
  )
})
