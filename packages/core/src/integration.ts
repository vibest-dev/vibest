import { Clock, ConfigProvider, Context, Effect, FileSystem, Layer, Path } from "effect"

import { Db } from "./db.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import * as Guard from "./guard.ts"
import { Harnesses } from "./harness.ts"
import type { HarnessDefinition } from "./host.ts"
import { Layout } from "./paths.ts"
import { jsonObject, promptOf, turnEndOf } from "./results.ts"
import { Sessions } from "./sessions.ts"

export type HookCaller = { readonly id: string; readonly agent: string; readonly harness: string }

const make = Effect.gen(function* () {
  const db = yield* Db
  const sessions = yield* Sessions
  const harnesses = yield* Harnesses
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const noteConversation = (definition: HarnessDefinition, who: HookCaller, raw: string) =>
    Effect.gen(function* () {
      const event = definition.conversationOf === undefined ? undefined : jsonObject(raw)
      const conversation = event && definition.conversationOf?.(event)
      if (conversation && (yield* db.noteHarnessSession(who.id, conversation)))
        yield* Effect.logInfo(`session ${who.id} is in conversation ${conversation}`)
    })

  const turnEnd = Effect.fn("Integration.turnEnd")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    yield* noteConversation(definition, who, raw)
    const end = turnEndOf(definition, who.agent, raw, yield* Clock.currentTimeMillis)
    if (!end) return
    yield* db.reportTurn(who.id, end)
    yield* db.updateSession(who.id, { status: "idle" })
    yield* Effect.log(`turn end ${who.id} (${end.harness}${end.interrupted ? ", interrupted" : ""})`)
  })

  const prompt = Effect.fn("Integration.prompt")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    yield* noteConversation(definition, who, raw)
    const text = promptOf(definition, who.agent, raw)
    if (text === undefined) return
    yield* sessions.userPrompt(who.id, text, yield* Clock.currentTimeMillis)
  })

  const ready = Effect.fn("Integration.ready")(function* (
    id: string,
    pid: number | undefined,
    reported?: { readonly version: string; readonly protocol: number },
  ) {
    yield* db.patchLive(id, {
      ready: yield* Clock.currentTimeMillis,
      ...(pid === undefined ? {} : { pid }),
      ...(reported === undefined ? {} : { integration: reported }),
    })
  })

  const guard = (agent: string, raw: string, projectId: string | undefined) =>
    Guard.check(agent, raw).pipe(
      Effect.provide(
        ConfigProvider.layerAdd(
          ConfigProvider.fromEnv({
            env: projectId === undefined ? {} : { VIBEST_PROJECT_DIR: layout.project(projectId) },
          }),
          { asPrimary: true },
        ),
      ),
      Effect.provideService(Harnesses, harnesses),
      Effect.provideService(Layout, layout),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.withSpan("Integration.guard"),
    )

  return { turnEnd, prompt, ready, guard }
})

export class Integration extends Context.Service<Integration, Effect.Success<typeof make>>()("vibest/Integration") {
  static readonly layer = Layer.effect(Integration, make)

  static readonly node = LayerNode.make({
    service: Integration,
    layer: Integration.layer,
    deps: [Db.node, Harnesses.node, Sessions.node, PlatformNode.fileSystem, PlatformNode.layout, PlatformNode.path],
  })
}
