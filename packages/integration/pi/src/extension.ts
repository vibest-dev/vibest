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
import { VERSION } from "@vibest/protocol/rpc"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Cause, Config, Deferred, Effect, Exit, FileSystem, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"

import { Pi } from "./pi.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

export const skillsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "skills")

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const COORDINATOR = "coordinator"

const guarded = (agent: string, sessionId: string | undefined) =>
  Effect.gen(function* () {
    const pi = yield* Pi
    const layout = yield* Layout
    yield* pi.handle("tool_call", (e, ctx) =>
      Effect.gen(function* () {
        const headers = yield* claimHeaders(
          sessionId ? { _tag: "session", sessionId, pluginVersion: VERSION } : { _tag: "cli", repositoryRoot: ctx.cwd },
        )
        const input = encodeJson({ tool_name: e.toolName, tool_input: e.input, cwd: ctx.cwd })
        const exit = yield* hookCall(layout.socket, headers, (client) =>
          client["Integration.Guard"]({ harness: "pi", agent, input }),
        )
        if (Exit.isFailure(exit))
          return {
            block: true,
            reason: `vibest could not check this tool call (${Cause.pretty(exit.cause)}); it is refused.`,
          }
        const reason = exit.value.answer
        return typeof reason === "string" && reason ? { block: true, reason } : undefined
      }),
    )
  })

type AgentMessage = AgentEndEvent["messages"][number]
type AssistantMessage = Extract<AgentMessage, { readonly role: "assistant" }>

const lastReply = (messages: ReadonlyArray<AgentMessage>) => {
  const message = messages.findLast((m): m is AssistantMessage => m.role === "assistant")
  const text = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
  return { text, error: message?.stopReason === "error" ? message.errorMessage || "error" : "" }
}

const piHeaders = (sessionId: string, ctx: ExtensionContext, current?: string) =>
  claimHeaders({
    _tag: "session",
    sessionId,
    harnessSessionId: ctx.sessionManager.getSessionId(),
    pluginVersion: VERSION,
    ...(current === undefined ? {} : { process: current }),
  })

type Role = Layer.Layer<never, Config.ConfigError, Pi | ClientServices | FileSystem.FileSystem>

const session = (sessionId: string, processId: Ref.Ref<string | undefined>): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      const layout = yield* Layout
      const root = yield* Ref.make(false)
      const reply = yield* Ref.make({ text: "", error: "" })
      yield* pi.handle("session_start", (_e, ctx) => Ref.set(root, ctx.mode === "tui"))
      yield* pi.handle("agent_end", (e) => Ref.set(reply, lastReply(e.messages)))
      yield* pi.handle("message_start", (e, ctx) =>
        Effect.gen(function* () {
          const message = e.message
          if (message.role !== "custom" || message.customType !== "vibest") return
          const details = message.details as { readonly execution?: unknown } | undefined
          if (typeof details?.execution !== "number") return
          const headers = yield* piHeaders(sessionId, ctx, yield* Ref.get(processId))
          const event = encodeJson({ type: "accepted", execution: details.execution })
          yield* hookCall(layout.socket, headers, (client) => client.Prompt({ sessionId, harness: "pi", event }))
        }),
      )
      yield* pi.handle("input", (e, ctx) =>
        Effect.gen(function* () {
          if (e.source === "extension" || e.text.trim() === "") return
          const headers = yield* piHeaders(sessionId, ctx, yield* Ref.get(processId))
          const event = encodeJson({ type: "input", text: e.text, source: e.source })
          yield* hookCall(layout.socket, headers, (client) => client.Prompt({ sessionId, harness: "pi", event }))
        }),
      )
      yield* pi.handle("agent_settled", (e, ctx) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(root)) || !ctx.isIdle()) return
          const { text, error } = yield* Ref.get(reply)
          const headers = yield* piHeaders(sessionId, ctx, yield* Ref.get(processId))
          const event = encodeJson({ type: "agent_settled", text, error, aborted: e.aborted })
          yield* hookCall(layout.socket, headers, (client) => client.ExecutionEnd({ sessionId, harness: "pi", event }))
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
          client["Session.Ready"](
            { id: sessionId, conversation: { harness: "pi", id: harnessSessionId } },
            { headers },
          ),
        ),
        Effect.scoped,
        Effect.timeout("1 second"),
        Effect.andThen(Ref.set(reported, harnessSessionId)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() =>
                ctx.ui.notify(
                  `vibest: the entry session's conversation may not have been saved: ${Cause.pretty(cause)}`,
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
  }),
)

const inbox = (sessionId: string, processId: Ref.Ref<string | undefined>): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      const started = yield* Deferred.make<ExtensionContext>()
      yield* pi.handle("session_start", (_e, ctx) =>
        ctx.mode === "tui" ? Deferred.succeed(started, ctx).pipe(Effect.asVoid) : Effect.void,
      )
      const identity = (ctx: ExtensionContext) =>
        Effect.map(Ref.get(processId), (current) => ({
          _tag: "session" as const,
          sessionId,
          harnessSessionId: ctx.sessionManager.getSessionId(),
          pluginVersion: VERSION,
          ...(current === undefined ? {} : { process: current }),
        }))
      const takeNext = (ctx: ExtensionContext) =>
        Effect.gen(function* () {
          if (!ctx.isIdle()) return
          const taken = yield* withVibest(yield* identity(ctx), (client) => client["Inbox.Take"](undefined), {
            start: false,
          })
          if (taken === null) return
          yield* pi.sendMessage(
            { customType: "vibest", content: taken.text, display: false, details: { execution: taken.execution } },
            { triggerTurn: true },
          )
        }).pipe(Effect.ignore)
      yield* pi.handle("agent_settled", (_e, ctx) => takeNext(ctx))
      const subscribe = (ctx: ExtensionContext) =>
        Effect.flatMap(identity(ctx), (who) =>
          withVibest(
            who,
            (client) =>
              client["Inbox.Subscribe"](undefined).pipe(
                Stream.runForEach(() => takeNext(ctx)),
                Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause))),
              ),
            { start: false },
          ),
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

const ready = (sessionId: string, processId: Ref.Ref<string | undefined>): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      const scope = yield* Effect.scope
      yield* pi.handle("session_start", (_e, ctx) =>
        ctx.mode !== "tui"
          ? Effect.void
          : Ref.get(processId).pipe(
              Effect.flatMap((current) =>
                withVibest(
                  {
                    _tag: "session",
                    sessionId,
                    pluginVersion: VERSION,
                    ...(current === undefined ? {} : { process: current }),
                  },
                  (client) => client["Session.Ready"]({ id: sessionId, pid: process.pid }),
                  { start: false },
                ),
              ),
              Effect.tap((answer) =>
                answer.process === undefined ? Effect.void : Ref.set(processId, String(answer.process)),
              ),
              Effect.timeout("2 seconds"),
              Effect.retry({
                while: (e) =>
                  e._tag === "DaemonUnavailable" || e._tag === "RpcClientError" || e._tag === "TimeoutError",
                schedule: Schedule.spaced("1 second"),
              }),
              Effect.ignore,
              Effect.forkIn(scope),
              Effect.asVoid,
            ),
      )
    }),
  )

export const extension = Layer.unwrap(
  Effect.gen(function* () {
    const agent = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
    if (!agent) return Layer.empty
    const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID")))
    const processId = yield* Ref.make(Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_PROCESS"))))
    const guarding: Role = Layer.effectDiscard(guarded(agent, sessionId))
    const guard = sessionId ? Layer.merge(guarding, ready(sessionId, processId)) : guarding
    const own = sessionId
      ? Layer.mergeAll(session(sessionId, processId), inbox(sessionId, processId)).pipe(Layer.provideMerge(guard))
      : guard
    return agent === COORDINATOR ? coordinator.pipe(Layer.provideMerge(own)) : own
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
