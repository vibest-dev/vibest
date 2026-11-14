import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path } from "effect"

import { Agents } from "./agents.ts"
import { runtimeOf, terminalOf } from "./database/db-rows.ts"
import { Db } from "./database/db.ts"
import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"
import * as Guard from "./guard.ts"
import { Harnesses } from "./harnesses.ts"
import type { HarnessDefinition } from "./plugin/domains.ts"
import { jsonObject, promptOf, executionEndOf } from "./replies.ts"
import { alive, Runtimes } from "./runtimes.ts"
import { Session } from "./session.ts"

export * as Integration from "./integration.ts"

export type HookCaller = {
  readonly id: string
  readonly entry: boolean
  readonly harness: string
  readonly process?: number | undefined
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const sessions = yield* Session.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const runtimes = yield* Runtimes.Service
  const layout = yield* Layout
  const vibest = yield* VibestCommand
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const noteConversation = (definition: HarnessDefinition, who: HookCaller, raw: string) =>
    Effect.gen(function* () {
      const event = definition.conversationOf === undefined ? undefined : jsonObject(raw)
      const conversation = event && definition.conversationOf?.(event)
      if (conversation && (yield* db.session.noteConversation(who.id, conversation, who.process)))
        yield* Effect.logInfo(`session ${who.id} is in conversation ${conversation}`)
    })

  const terminalClosed = (id: string) =>
    Effect.gen(function* () {
      const session = yield* db.session.getSession(id)
      if (session === undefined || terminalOf(session).id === "") return false
      const runtime = yield* runtimes.route(runtimeOf(session)).pipe(Effect.option)
      return Option.isSome(runtime) && !(yield* alive(runtime.value, terminalOf(session)))
    })

  const executionEnd = Effect.fn("Integration.executionEnd")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    const end = executionEndOf(definition, raw, yield* Clock.currentTimeMillis)
    if (!end) return yield* noteConversation(definition, who, raw)
    if (end.status === "interrupted" && (yield* terminalClosed(who.id))) {
      yield* Effect.log(`execution end ${who.id} (${end.harness}, interrupted as its terminal closed: an exit)`)
      return yield* sessions.check(who.id)
    }
    const written = yield* db.session.endObserved(who.id, end, who.process)
    yield* Effect.log(`execution end ${who.id} (${end.harness}, ${written ?? `${end.status} ignored`})`)
  })

  const prompt = Effect.fn("Integration.prompt")(function* (who: HookCaller, raw: string) {
    const definition = harnesses.find(who.harness)
    if (definition === undefined) return
    yield* noteConversation(definition, who, raw)
    const prompt = promptOf(definition, raw)
    if (prompt === undefined) return
    if ("execution" in prompt) {
      if (prompt.refused) return yield* sessions.typeTaken(who.id, prompt.execution)
      if (yield* db.session.acceptExecution(who.id, prompt.execution)) yield* db.session.setStatus(who.id, "working")
      return
    }
    yield* sessions.userPrompt(who.id, prompt.text, yield* Clock.currentTimeMillis, who.process)
  })

  const ready = Effect.fn("Integration.ready")(function* (
    id: string,
    pid: number | undefined,
    reported?: { readonly version: string; readonly protocol: number },
    reporter?: number,
  ) {
    return yield* db.session.patchLive(id, {
      ready: yield* Clock.currentTimeMillis,
      reporter,
      ...(pid === undefined ? {} : { pid }),
      ...(reported === undefined ? {} : { integration: reported }),
    })
  })

  const guard = Effect.fn("Integration.guard")(
    function* (sessionId: string, raw: string) {
      const row = yield* db.session.sessionIdentity(sessionId)
      if (row === undefined) return `no session ${sessionId}; the tool call is refused.`
      return yield* Guard.check({ id: row.id, agent: row.agent, projectDir: layout.project(row.projectId) }, raw)
    },
    Effect.provideService(Agents.Service, agents),
    Effect.provideService(Harnesses.Service, harnesses),
    Effect.provideService(Layout, layout),
    Effect.provideService(Runtimes.Service, runtimes),
    Effect.provideService(VibestCommand, vibest),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  )

  const conversation = Effect.fn("Integration.conversation")(
    (id: string, conversation: string, process: number | undefined) =>
      db.session.noteConversation(id, conversation, process),
  )

  return { executionEnd, prompt, ready, conversation, guard }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Integration") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agents.node,
    Db.node,
    Harnesses.node,
    Runtimes.node,
    Session.node,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
