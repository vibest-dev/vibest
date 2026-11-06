import path from "node:path"
import url from "node:url"

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import {
  claimHeaders,
  type ClientServices,
  connect,
  hookCall,
  SocketConnector,
  withVibest,
} from "@vibest/client/client"
import * as Guard from "@vibest/core/guard"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { VERSION } from "@vibest/protocol/rpc"
import { Cause, Config, Deferred, Effect, FileSystem, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"

import { Pi } from "./pi.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

export const skillsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "skills")

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const guarded = (rules: Guard.Rules) =>
  Effect.gen(function* () {
    const pi = yield* Pi
    yield* pi.handle("tool_call", (e, ctx) =>
      rules({ tool: e.toolName, input: e.input, cwd: ctx.cwd }).pipe(
        Effect.map((reason) => (reason ? { block: true, reason } : undefined)),
      ),
    )
  })

type AgentMessage = AgentEndEvent["messages"][number]
type AssistantMessage = Extract<AgentMessage, { readonly role: "assistant" }>

const lastReply = (messages: ReadonlyArray<AgentMessage>) => {
  const message = messages.findLast((m): m is AssistantMessage => m.role === "assistant")
  const text = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
  return { text, error: message?.stopReason === "error" ? message.errorMessage || "error" : "" }
}

const piHeaders = (sessionId: string, ctx: ExtensionContext) =>
  claimHeaders({
    _tag: "session",
    sessionId,
    harnessSessionId: ctx.sessionManager.getSessionId(),
    pluginVersion: VERSION,
  })

type Role = Layer.Layer<never, Config.ConfigError, Pi | ClientServices | FileSystem.FileSystem>

const session = (sessionId: string): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      const layout = yield* Layout
      const root = yield* Ref.make(false)
      const reply = yield* Ref.make({ text: "", error: "" })
      yield* pi.handle("session_start", (_e, ctx) => Ref.set(root, ctx.mode === "tui"))
      yield* pi.handle("agent_end", (e) => Ref.set(reply, lastReply(e.messages)))
      yield* pi.handle("input", (e, ctx) =>
        Effect.gen(function* () {
          if (e.source === "extension" || e.text.trim() === "") return
          const headers = yield* piHeaders(sessionId, ctx)
          const event = encodeJson({ type: "input", text: e.text, source: e.source })
          yield* hookCall(layout.socket, headers, (client) => client.Prompt({ sessionId, harness: "pi", event }))
        }),
      )
      yield* pi.handle("agent_settled", (e, ctx) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(root)) || !ctx.isIdle()) return
          const { text, error } = yield* Ref.get(reply)
          const headers = yield* piHeaders(sessionId, ctx)
          const event = encodeJson({ type: "agent_settled", text, error, aborted: e.aborted })
          yield* hookCall(layout.socket, headers, (client) => client.TurnEnd({ sessionId, harness: "pi", event }))
        }),
      )
    }),
  )

const reportSession = Effect.fn("reportSession")(function* (sessionId: string) {
  const pi = yield* Pi
  const layout = yield* Layout
  const scope = yield* Effect.scope
  const reported = yield* Ref.make("")
  const send = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const harnessSessionId = ctx.sessionManager.getSessionId()
      if (ctx.mode !== "tui" || (yield* Ref.get(reported)) === harnessSessionId) return
      const headers = yield* piHeaders(sessionId, ctx)
      yield* connect(layout.socket).pipe(
        Effect.flatMap((client) =>
          client.CoordinatorSessionReady({ sessionId, harness: "pi", harnessSessionId }, { headers }),
        ),
        Effect.scoped,
        Effect.timeout("1 second"),
        Effect.andThen(Ref.set(reported, harnessSessionId)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() =>
                ctx.ui.notify(
                  `vibest: the coordinator's conversation may not have been saved: ${Cause.pretty(cause)}`,
                  "warning",
                ),
              ),
        ),
        Effect.forkIn(scope),
      )
    })
  yield* pi.handle("session_start", (event, ctx) =>
    event.reason === "new" || event.reason === "resume" || event.reason === "fork" ? send(ctx) : Effect.void,
  )
  yield* pi.handle("agent_end", (_event, ctx) => send(ctx))
})

const coordinator: Role = Layer.effectDiscard(
  Effect.gen(function* () {
    const pi = yield* Pi
    yield* pi.handle("resources_discover", () => Effect.succeed({ skillPaths: [skillsDir] }))
    yield* pi.handle("before_agent_start", (e) =>
      Effect.sync(() => {
        e.systemPromptOptions.sections = {}
      }),
    )
    yield* pi.load(toolGroups)
    yield* pi.load(compactUserMessages)
    const sessionId = yield* Config.option(Config.String("VIBEST_SESSION_ID"))
    if (Option.isNone(sessionId)) return
    yield* reportSession(sessionId.value)
    const started = yield* Deferred.make<ExtensionContext>()
    yield* pi.handle("session_start", (_e, ctx) =>
      ctx.mode === "tui" ? Deferred.succeed(started, ctx).pipe(Effect.asVoid) : Effect.void,
    )
    const subscribe = (ctx: ExtensionContext) =>
      withVibest(
        {
          _tag: "session",
          sessionId: sessionId.value,
          harnessSessionId: ctx.sessionManager.getSessionId(),
          pluginVersion: VERSION,
        },
        (client) =>
          client["Inbox.Subscribe"](undefined).pipe(
            Stream.runForEach((content) =>
              pi.sendMessage(
                { customType: "vibest", content, display: false },
                { triggerTurn: true, deliverAs: "followUp" },
              ),
            ),
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause))),
          ),
        { start: false },
      ).pipe(
        Effect.retry({
          while: (e) => e._tag === "RpcClientError" || e._tag === "DaemonUnavailable",
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.repeat(Schedule.spaced("2 seconds")),
      )
    yield* Deferred.await(started).pipe(
      Effect.flatMap((ctx) =>
        subscribe(ctx).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => ctx.ui.notify(`vibest: inbox subscription ended: ${Cause.pretty(cause)}`, "error")),
          ),
        ),
      ),
      Effect.forkScoped,
    )
  }),
)

const ready = (sessionId: string): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      yield* pi.handle("session_start", (_e, ctx) =>
        ctx.mode !== "tui"
          ? Effect.void
          : withVibest(
              { _tag: "session", sessionId, pluginVersion: VERSION },
              (client) => client["Session.Ready"]({ id: sessionId, pid: process.pid }),
              { start: false },
            ).pipe(Effect.timeout("2 seconds"), Effect.ignore),
      )
    }),
  )

export const extension = Layer.unwrap(
  Effect.gen(function* () {
    const agent = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
    if (!agent) return Layer.empty
    const guarding: Role = Layer.effectDiscard(guarded(Guard.rulesOf(agent)))
    const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID")))
    const guard = sessionId ? Layer.merge(guarding, ready(sessionId)) : guarding
    if (agent === Guard.COORDINATOR) return coordinator.pipe(Layer.provideMerge(guard))
    return sessionId ? session(sessionId).pipe(Layer.provideMerge(guard)) : guard
  }),
)

const vibestCommand = Layer.effect(
  VibestCommand,
  Config.schema(Schema.fromJsonString(Schema.Array(Schema.String)), "VIBEST_COMMAND").pipe(
    Config.withDefault(["vibest"]),
  ),
)

export const services = Layer.mergeAll(
  Layout.layer,
  NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeFileSystem.layer)),
  NodeFileSystem.layer,
  Layer.succeed(SocketConnector, (endpoint) => NodeSocket.makeNet({ path: endpoint })),
  vibestCommand,
).pipe(Layer.provideMerge(NodePath.layer))

export default (api: ExtensionAPI) => Pi.runMain(api, extension.pipe(Layer.provide(services)))
