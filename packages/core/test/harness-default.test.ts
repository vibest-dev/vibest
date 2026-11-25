import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { harnessDefaultPlugin } from "../../plugin-builtins/src/harness-default.ts"
import { Agents } from "../src/agents.ts"
import { makePlugins } from "../src/plugin.ts"
import { harnessesLayer, runtimesLayer, subscriptionsLayer } from "./lib/harnesses.ts"
import { memoryPluginHost } from "./platform/bun.ts"

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
  subscriptions: [],
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: claude },
  ],
})

const chosen = (harness: string | undefined, claude: boolean, saved?: string) =>
  makePlugins([
    {
      source: "builtin:vibest.harness-default",
      revision: "1",
      options: {},
      plugin: harnessDefaultPlugin(Effect.succeed(saved)),
    },
  ]).pipe(
    Effect.flatMap((plugins) => plugins.start(event(harness, claude))),
    Effect.map((decision) => decision.harness),
    Effect.provide(subscriptionsLayer),
    Effect.provide(harnessesLayer()),
    Effect.provide(runtimesLayer),
    Effect.provide(Agents.layer),
    Effect.provide(memoryPluginHost),
    Effect.provide(Agents.layer),
    Effect.scoped,
  )

describe("vibest.harness-default", () => {
  it.effect("chooses claude only when the harness is unset and claude is available", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* chosen(undefined, true), "claude")
      assert.strictEqual(yield* chosen("pi", true), "pi")
      assert.strictEqual(yield* chosen(undefined, false), undefined)
    }),
  )

  it.effect("a saved defaultHarness comes before claude, and only when it is available", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* chosen(undefined, true, "pi"), "pi")
      assert.strictEqual(yield* chosen(undefined, true, "cursor"), "claude")
      assert.strictEqual(yield* chosen("claude", true, "pi"), "claude")
    }),
  )
})
