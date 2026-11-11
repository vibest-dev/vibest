import { Clock, ConfigProvider, Context, Effect, FileSystem, Layer, Path } from "effect"

import { Db } from "./db.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import * as Guard from "./guard.ts"
import { Harnesses } from "./harness.ts"
import type { HarnessDefinition } from "./host.ts"
import { Layout } from "./paths.ts"
import { jsonObject, promptOf, executionEndOf } from "./replies.ts"
import { Sessions } from "./sessions.ts"

export type HookCaller = {
  readonly id: string
  readonly agent: string
  readonly entry: boolean
  readonly harness: string
  readonly process?: number | undefined
}

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
      if (conversation && (yield* db.noteConversation(who.id, conversation, who.process)))
        yield* Effect.logInfo(`session ${who.id} is in conversation ${conversation}`)
    })

  const executionEnd = Effect.fn("Integration.executionEnd")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    const end = executionEndOf(definition, who.entry, raw, yield* Clock.currentTimeMillis)
    if (!end) return yield* noteConversation(definition, who, raw)
    const written = yield* db.endObserved(who.id, end, who.process)
    yield* Effect.log(`execution end ${who.id} (${end.harness}, ${written ?? `${end.status} ignored`})`)
  })

  const prompt = Effect.fn("Integration.prompt")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    yield* noteConversation(definition, who, raw)
    const text = promptOf(definition, who.entry, raw)
    if (text === undefined) return
    yield* sessions.userPrompt(who.id, text, yield* Clock.currentTimeMillis, who.process)
  })

  const ready = Effect.fn("Integration.ready")(function* (
    id: string,
    pid: number | undefined,
    reported?: { readonly version: string; readonly protocol: number },
    reporter?: number,
  ) {
    return yield* db.patchLive(id, {
      ready: yield* Clock.currentTimeMillis,
      reporter,
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

  const conversation = (id: string, conversation: string, process: number | undefined) =>
    db.noteConversation(id, conversation, process)

  return { executionEnd, prompt, ready, conversation, guard }
})

export class Integration extends Context.Service<Integration, Effect.Success<typeof make>>()("vibest/Integration") {
  static readonly layer = Layer.effect(Integration, make)

  static readonly node = LayerNode.make({
    service: Integration,
    layer: Integration.layer,
    deps: [Db.node, Harnesses.node, Sessions.node, PlatformNode.fileSystem, PlatformNode.layout, PlatformNode.path],
  })
}
