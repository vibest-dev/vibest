import path from "node:path"
import url from "node:url"

// vibest's Pi extension. VIBEST_AGENT=coordinator makes it the coordinator (inbox rows delivered in process instead of typed
// into the pane); with VIBEST_SESSION_ID it reports the neutral integration events (ready, conversation, turn start and
// end) to vibestd's HTTP socket and asks `/guard` about every tool call; otherwise it is inert. Both run vibest itself as
// `vibest` commands in Pi's bash tool.
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import { claimHeaders, type ClientServices, hookPost, SocketConnector, withVibest } from "@vibest/client/client"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { EVENTS_ROUTE, GUARD_ROUTE, type IntegrationEvent } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { isUsageLimitError, toolCallOf } from "@vibest/protocol/tools"
import { Cause, Config, Deferred, Effect, FileSystem, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"

import { Pi } from "./pi.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

/** The plugin's `skills/` directory beside this module (`src/skills` in source, `harnesses/pi/skills` when built). */
export const skillsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "skills")

/** Every tool call through vibestd's guard (`/guard`); no answer refuses it. */
const guarded = (sessionId: string) =>
  Effect.gen(function* () {
    const pi = yield* Pi
    const layout = yield* Layout
    yield* pi.handle("tool_call", (e, ctx) =>
      Effect.gen(function* () {
        const headers = yield* piHeaders(sessionId)
        const tool = toolCallOf(e.toolName, e.input as Readonly<Record<string, unknown>>, ctx.cwd)
        const reply = yield* hookPost(layout.httpSocket, GUARD_ROUTE, headers, { tool })
        const deny =
          reply.status === 200 ? (reply.body as { deny?: unknown } | undefined)?.deny : `status ${reply.status}`
        return typeof deny === "string" ? { block: true, reason: deny } : undefined
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed({ block: true, reason: "vibestd unreachable; the tool call is refused." }),
        ),
      ),
    )
  })

/** One neutral event to vibestd (`/events`); fails unless vibestd took it. */
const send = (sessionId: string, event: IntegrationEvent) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const headers = yield* piHeaders(sessionId)
    const reply = yield* hookPost(layout.httpSocket, EVENTS_ROUTE, headers, event)
    if (reply.status >= 300) return yield* Effect.fail(new Error(`vibestd answered ${reply.status}`))
  })

/** `send`, a missed one only lost. */
const report = (sessionId: string, event: IntegrationEvent) => send(sessionId, event).pipe(Effect.ignore)

type AgentMessage = AgentEndEvent["messages"][number]
type AssistantMessage = Extract<AgentMessage, { readonly role: "assistant" }>

/** Text and error of the last assistant message of a run. */
const lastReply = (messages: ReadonlyArray<AgentMessage>) => {
  const message = messages.findLast((m): m is AssistantMessage => m.role === "assistant")
  const text = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
  return { text, error: message?.stopReason === "error" ? message.errorMessage || "error" : "" }
}

/**
 * This Pi session's headers: its vibest session, its environment and this extension's version (`vibest update` restarts
 * old ones). Not Pi's own session id: a Pi nested in the session inherits its environment, so only a `conversation`
 * event names the conversation.
 */
const piHeaders = (sessionId: string) => claimHeaders({ _tag: "session", sessionId, pluginVersion: VERSION })

/** What an agent's layer needs; they share one type, so picking one is a plain conditional. */
type Role = Layer.Layer<never, Config.ConfigError, Pi | ClientServices | FileSystem.FileSystem>

const session = (sessionId: string): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      // TUI only: RPC / JSON / print modes have no PTY, so they are not the session's root (harness) session.
      const root = yield* Ref.make(false)
      const reply = yield* Ref.make({ text: "", error: "" })
      yield* pi.handle("session_start", (_e, ctx) => Ref.set(root, ctx.mode === "tui"))
      yield* pi.handle("agent_end", (e) => Ref.set(reply, lastReply(e.messages)))
      // `input` is the submitted prompt. `extension` is sendUserMessage, which is vibest's own text, not the user.
      yield* pi.handle("input", (e) =>
        e.source === "extension" || e.text.trim() === ""
          ? Effect.void
          : report(sessionId, { type: "turn.start", origin: "typed", text: e.text }),
      )
      yield* pi.handle("agent_settled", (e, ctx) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(root)) || !ctx.isIdle()) return
          const { text, error } = yield* Ref.get(reply)
          yield* report(
            sessionId,
            e.aborted
              ? { type: "turn.end", outcome: "interrupted", text }
              : error
                ? {
                    type: "turn.end",
                    outcome: "failed",
                    text,
                    failure: { kind: isUsageLimitError(error) ? "limited" : "other", message: error },
                  }
                : { type: "turn.end", outcome: "completed", text },
          )
        }),
      )
    }),
  )

/**
 * `vibest --harness pi` reopens the conversation it reported: a TUI `session_start` for `new`, `resume`, or `fork`, and
 * every `agent_end`, report it (`conversation`); the last report wins. Print / RPC mode does not report.
 */
const reportSession = Effect.fn("reportSession")(function* (sessionId: string) {
  const pi = yield* Pi
  const scope = yield* Effect.scope
  const reported = yield* Ref.make("")
  const conversation = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const id = ctx.sessionManager.getSessionId()
      if (ctx.mode !== "tui" || (yield* Ref.get(reported)) === id) return
      yield* send(sessionId, { type: "conversation", conversation: id }).pipe(
        Effect.timeout("1 second"),
        Effect.andThen(Ref.set(reported, id)),
        // Unanswered is not unsaved: vibestd may still apply it (the last one applied wins).
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
  // shortcut: an empty /new has no file yet; pinned Pi 1.1.0 --session-id warns and recreates that id. Revisit only if Pi exits on a missing id.
  yield* pi.handle("session_start", (event, ctx) =>
    event.reason === "new" || event.reason === "resume" || event.reason === "fork" ? conversation(ctx) : Effect.void,
  )
  yield* pi.handle("agent_end", (_event, ctx) => conversation(ctx))
})

/** Inbox rows for this pane, as custom messages the model sees but the TUI hides: a turn starts when Pi is idle, otherwise they queue as follow-ups. */
const coordinator: Role = Layer.effectDiscard(
  Effect.gen(function* () {
    const pi = yield* Pi
    // Only the main agent (`VIBEST_AGENT=coordinator`) gets vibest's multi-agent skills (`delegate` and `pipeline`).
    yield* pi.handle("resources_discover", () => Effect.succeed({ skillPaths: [skillsDir] }))
    // Clear the prompt sections other extensions add for a coding agent. Pi runs these handlers in extension load order,
    // so only sections added by extensions loaded before pi-vibest are cleared; ones loaded after it keep theirs.
    // Turns started by inbox rows skip this event and get the base prompt, which never has them.
    yield* pi.handle("before_agent_start", (e) =>
      Effect.sync(() => {
        e.systemPromptOptions.sections = {}
      }),
    )
    // The coordinator's TUI: grouped tool calls and compact user messages. Other agents and plain Pi keep Pi's own.
    yield* pi.load(toolGroups)
    yield* pi.load(compactUserMessages)
    const sessionId = yield* Config.option(Config.String("VIBEST_SESSION_ID"))
    if (Option.isNone(sessionId)) return
    yield* reportSession(sessionId.value)
    // Pi children of the coordinator (print / RPC mode) inherit VIBEST_AGENT; only the TUI session takes the rows.
    const started = yield* Deferred.make<ExtensionContext>()
    yield* pi.handle("session_start", (_e, ctx) =>
      ctx.mode === "tui" ? Deferred.succeed(started, ctx).pipe(Effect.asVoid) : Effect.void,
    )
    const subscribe = () =>
      withVibest(
        // No conversation header: only a `conversation` event names it (a nested Pi TUI shares this environment).
        { _tag: "session", sessionId: sessionId.value, pluginVersion: VERSION },
        (client) =>
          client["Inbox.Subscribe"](undefined).pipe(
            Stream.runForEach((content) =>
              pi.sendMessage(
                { customType: "vibest", content, display: false },
                { triggerTurn: true, deliverAs: "followUp" },
              ),
            ),
            // A vibestd that stops interrupts the stream on its side, and the call ends with that interruption. It is not
            // this fiber's own (that one never reaches here), so it ends the stream like any close: subscribe again.
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause))),
          ),
        // Never start vibestd from here: during `vibest daemon restart` the replacement may be between sockets.
        { start: false },
      ).pipe(
        // The connection dropped or vibestd closed the stream (vibestd restarted): subscribe again; rows not yet taken stay pending.
        Effect.retry({
          while: (e) => e._tag === "RpcClientError" || e._tag === "DaemonUnavailable",
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.repeat(Schedule.spaced("2 seconds")),
      )
    // Anything else ends the subscription; no handler is running, so tell the user.
    yield* Deferred.await(started).pipe(
      Effect.flatMap((ctx) =>
        subscribe().pipe(
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

/** Once the TUI session starts, tell vibestd this harness takes input and its pid (`ready`): a restart signals that pid. */
const ready = (sessionId: string): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      yield* pi.handle("session_start", (_e, ctx) =>
        ctx.mode !== "tui"
          ? Effect.void
          : send(sessionId, { type: "ready", pid: process.pid }).pipe(Effect.timeout("2 seconds"), Effect.ignore),
      )
    }),
  )

/**
 * The agent from the environment: every vibest session asks vibestd's guard and reports its events; the coordinator also
 * takes its inbox rows. No VIBEST_AGENT or VIBEST_SESSION_ID: nothing at all.
 */
export const extension = Layer.unwrap(
  Effect.gen(function* () {
    const agent = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
    const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID")))
    // vibestd knows the session's agent from its id: without one, no guard and no events (a Pi run outside vibest); a
    // coordinator TUI still gets its look.
    if (!agent || !sessionId) return agent === "coordinator" ? coordinator : Layer.empty
    const guard = Layer.merge(Layer.effectDiscard(guarded(sessionId)), ready(sessionId))
    if (agent === "coordinator") return coordinator.pipe(Layer.provideMerge(guard))
    return session(sessionId).pipe(Layer.provideMerge(guard))
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
