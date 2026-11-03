import path from "node:path"
import url from "node:url"

// vibest's Pi extension. VIBEST_AGENT=coordinator makes it the coordinator (inbox rows delivered in process instead of typed
// into the pane), any other agent with VIBEST_SESSION_ID a session (its turn starts and ends sent to vibestd); otherwise it
// is inert. Either way tool calls go through that agent's rules in vibest's guard.ts, in process. Both run vibest itself as `vibest` commands in Pi's bash tool.
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
import { writeTerminalStatus } from "@vibest/core/results"
import { VERSION } from "@vibest/protocol/rpc"
import { Cause, Config, Deferred, Effect, FileSystem, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"

import { Pi } from "./pi.ts"
import toolGroups from "./tui/tool-groups.ts"
import compactUserMessages from "./tui/user-message-padding.ts"

/** The plugin's `skills/` directory beside this module (`src/skills` in source, `harnesses/pi/skills` when built). */
export const skillsDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "skills")

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** vibest's tool-call rules for this agent, as Pi's tool_call result. */
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

/** Text and error of the last assistant message of a run. */
const lastReply = (messages: ReadonlyArray<AgentMessage>) => {
  const message = messages.findLast((m): m is AssistantMessage => m.role === "assistant")
  const text = (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
  return { text, error: message?.stopReason === "error" ? message.errorMessage || "error" : "" }
}

/** This Pi session's headers: its vibest session, its environment, Pi's own session id, and this extension's version (`vibest update` restarts old ones). */
const piHeaders = (sessionId: string, ctx: ExtensionContext) =>
  claimHeaders({
    _tag: "session",
    sessionId,
    harnessSessionId: ctx.sessionManager.getSessionId(),
    pluginVersion: VERSION,
  })

/** What an agent's layer needs; they share one type, so picking one is a plain conditional. */
type Role = Layer.Layer<never, Config.ConfigError, Pi | ClientServices | FileSystem.FileSystem>

const session = (sessionId: string): Role =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pi = yield* Pi
      const layout = yield* Layout
      // TUI only: RPC / JSON / print modes have no PTY, so they are not the session's root (harness) session.
      const root = yield* Ref.make(false)
      const reply = yield* Ref.make({ text: "", error: "" })
      yield* pi.handle("session_start", (_e, ctx) => Ref.set(root, ctx.mode === "tui"))
      yield* pi.handle("agent_end", (e) => Ref.set(reply, lastReply(e.messages)))
      // `input` is the submitted prompt. `extension` is sendUserMessage, which is vibest's own text, not the user.
      // vibestd writes the turn-start line and records the round (the Pi adapter's `userPrompt` reads this event).
      yield* pi.handle("input", (e, ctx) =>
        Effect.gen(function* () {
          if (e.source === "extension" || e.text.trim() === "") return
          const headers = yield* piHeaders(sessionId, ctx)
          const event = encodeJson({ type: "input", text: e.text, source: e.source })
          yield* hookCall(layout.socket, headers, (client) => client.Prompt({ sessionId, harness: "pi", event }))
          yield* writeTerminalStatus("working")
        }),
      )
      // vibestd writes the result file and the turn-end line (the Pi adapter's `turnEnd` reads this event).
      yield* pi.handle("agent_settled", (e, ctx) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(root)) || !ctx.isIdle()) return
          const { text, error } = yield* Ref.get(reply)
          yield* writeTerminalStatus("idle")
          const headers = yield* piHeaders(sessionId, ctx)
          const event = encodeJson({ type: "agent_settled", text, error, aborted: e.aborted })
          yield* hookCall(layout.socket, headers, (client) => client.TurnEnd({ sessionId, harness: "pi", event }))
        }),
      )
    }),
  )

/**
 * `vibest --harness pi` reopens the conversation it reported. A TUI `session_start` for `new`, `resume`, or `fork` sends
 * that id before another turn; `agent_end` still sends the first startup id and retries a report that did not succeed.
 * The last report wins. Print / RPC mode does not report.
 */
const reportSession = Effect.fn("reportSession")(function* (sessionId: string) {
  const pi = yield* Pi
  const layout = yield* Layout
  const scope = yield* Effect.scope
  const reported = yield* Ref.make("")
  const send = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const harnessSessionId = ctx.sessionManager.getSessionId()
      if (ctx.mode !== "tui" || (yield* Ref.get(reported)) === harnessSessionId) return
      // Never starts vibestd: `vibest` already did.
      const headers = yield* piHeaders(sessionId, ctx)
      yield* connect(layout.socket).pipe(
        Effect.flatMap((client) =>
          client.CoordinatorSessionReady({ sessionId, harness: "pi", harnessSessionId }, { headers }),
        ),
        Effect.scoped,
        Effect.timeout("1 second"),
        Effect.andThen(Ref.set(reported, harnessSessionId)),
        // Unanswered is not unsaved: vibestd may still apply it (and keeps the newest either way).
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
    event.reason === "new" || event.reason === "resume" || event.reason === "fork" ? send(ctx) : Effect.void,
  )
  yield* pi.handle("agent_end", (_event, ctx) => send(ctx))
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

/**
 * Once the TUI session starts, tell vibestd this harness takes input and its pid (Session.Ready): it waits for that before
 * a turn, and a restart signals that pid.
 */
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

/**
 * The agent from the environment: VIBEST_AGENT alone decides the tool rules, as in the hook script; the coordinator also
 * takes its inbox rows, another agent with VIBEST_SESSION_ID writes its turn's result. No VIBEST_AGENT: nothing at all.
 */
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
