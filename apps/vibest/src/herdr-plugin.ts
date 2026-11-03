// `vibest herdr`: the command group the herdr plugin runs. The project directory comes from
// HERDR_PLUGIN_CONTEXT_JSON (focused pane, else workspace). Never from this process's cwd, which is the plugin directory.
import readline from "node:readline"

import { type Claim, type VibestClient, withVibest } from "@vibest/client/client"
import { VibestCommand } from "@vibest/core/paths"
import type { SessionInfo } from "@vibest/protocol/rpc"
import { callerMachine } from "@vibest/runtime-herdr/caller"
import { KIND, parseTerminal } from "@vibest/runtime-herdr/terminal-runtime"
import { RuntimeAddress } from "@vibest/schema/session"
import { Config, Console, Effect, Option, Schema } from "effect"
import { Herdr } from "effect-herdr-sdk"
import { Command } from "effect/cli"

/** HERDR_PLUGIN_CONTEXT_JSON is missing or not the object herdr documents. */
export class BadPluginContext extends Schema.TaggedError<BadPluginContext>()("BadPluginContext", {
  message: Schema.String,
}) {}

/** The popup prompt was empty. Same tag the other commands use for empty text. */
export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

/** The focused pane is not one of this project's live sessions. */
export class NoFocusedSession extends Schema.TaggedError<NoFocusedSession>()("NoFocusedSession", {
  message: Schema.String,
}) {}

export interface PluginContext {
  readonly workspaceId: string | undefined
  readonly workspaceCwd: string | undefined
  readonly focusedPaneId: string | undefined
  readonly focusedPaneCwd: string | undefined
  readonly focusedPaneAgent: string | undefined
}

export interface LiveSession {
  readonly id: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly paneId: string | undefined
}

export interface UsageWindow {
  readonly harness: string
  readonly window: string
  readonly percent: number
  readonly status: "available" | "limited"
}

type Step<A, E, R> = Effect.Effect<A, E, R>

/** What the commands ask vibestd and herdr to do. The fake the tests pass never fails and needs nothing; the live
 * daemon's steps fail with the RPC's and herdr's errors (E) and need the CLI's services (R). */
export interface HerdrDaemon<E = never, R = never> {
  /** Republish pane metadata for live herdr sessions. `directory` is only the caller header, not a filter. */
  readonly republish: (directory: string | undefined) => Step<number, E, R>
  readonly openMain: (
    directory: string,
  ) => Step<{ readonly action: "focused" | "opened"; readonly place: string }, E, R>
  readonly spawn: (directory: string, prompt: string) => Step<string, E, R>
  readonly interrupt: (id: string) => Step<void, E, R>
  /** Live sessions only: `directory` set, that project's; unset, every project's (`stop` matches a pane). */
  readonly list: (directory: string | undefined) => Step<ReadonlyArray<LiveSession>, E, R>
  /** `undefined` or empty: usage is not available. */
  readonly usage: () => Step<ReadonlyArray<UsageWindow> | undefined, E, R>
}

const field = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)

/** The documented context object. Unknown keys (worktree, selection) are ignored. Null cwd fields are absent. */
export const parsePluginContext = (raw: string) =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return yield* new BadPluginContext({ message: "HERDR_PLUGIN_CONTEXT_JSON is not JSON" })
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* new BadPluginContext({ message: "HERDR_PLUGIN_CONTEXT_JSON is not an object" })
    }
    const record = parsed as Record<string, unknown>
    return {
      workspaceId: field(record.workspace_id),
      workspaceCwd: field(record.workspace_cwd),
      focusedPaneId: field(record.focused_pane_id),
      focusedPaneCwd: field(record.focused_pane_cwd),
      focusedPaneAgent: field(record.focused_pane_agent),
    } satisfies PluginContext
  })

/** Focused pane directory, else the workspace directory. Never the process cwd. */
export const projectDirectory = (context: PluginContext) => context.focusedPaneCwd ?? context.workspaceCwd

const requireDirectory = (context: PluginContext) => {
  const directory = projectDirectory(context)
  if (directory === undefined) {
    return Effect.fail(
      new BadPluginContext({ message: "the herdr context has no focused pane or workspace directory" }),
    )
  }
  return Effect.succeed(directory)
}

export const formatRuns = (sessions: ReadonlyArray<LiveSession>) => {
  if (sessions.length === 0) return "no live sessions"
  return sessions
    .map((session) => [session.id, session.agent, session.harness, session.status, session.paneId ?? "-"].join("  "))
    .join("\n")
}

export const formatUsage = (usage: ReadonlyArray<UsageWindow> | undefined) => {
  if (usage === undefined || usage.length === 0) return "unknown"
  return usage.map((window) => `${window.harness}  ${window.window}  ${window.percent}%  ${window.status}`).join("\n")
}

const AGENT_NAME = /^s-([0-9a-f]{8})$/

/** The live subagent in the focused pane, else the session whose herdr agent name is `s-<id>`. The main agent is not one. */
export const sessionToStop = (
  sessions: ReadonlyArray<LiveSession>,
  paneId: string | undefined,
  agent: string | undefined,
) => {
  const live = sessions.filter((session) => session.agent !== "main")
  const byPane = paneId === undefined ? undefined : live.find((session) => session.paneId === paneId)
  if (byPane) return byPane.id
  const id = agent === undefined ? undefined : AGENT_NAME.exec(agent)?.[1]
  return id === undefined ? undefined : live.find((session) => session.id === id)?.id
}

/** Numbered menu. startup is a hook, and the palette does not list itself. */
export const ACTIONS = [
  ["open-main", "Open or focus the main agent"],
  ["run", "Run a subagent"],
  ["stop", "Stop the session in the focused pane"],
  ["runs", "List live sessions"],
  ["subscriptions", "Subscription usage"],
] as const

export const paletteMenu = () => ACTIONS.map(([id, title], index) => `${index + 1}  ${id}  ${title}`).join("\n")

export const VERBS = ["startup", "open-main", "run", "stop", "runs", "subscriptions", "palette"] as const
export type Verb = (typeof VERBS)[number]

const actionAt = (choice: string) => {
  if (!/^[1-9][0-9]*$/.test(choice)) return undefined
  const index = Number(choice)
  return index <= ACTIONS.length ? ACTIONS[index - 1] : undefined
}

/**
 * Run one plugin verb. `write` is for text the user must see before the next line (the menu, `Prompt:`).
 * The returned string is the rest, printed after.
 */
export const perform = <E, R>(
  verb: Verb,
  context: PluginContext,
  daemon: HerdrDaemon<E, R>,
  readLine: () => Effect.Effect<string, never, R>,
  write: (text: string) => Effect.Effect<void, never, R>,
) => {
  const go = (current: Verb): Effect.Effect<string, BadPluginContext | EmptyInput | NoFocusedSession | E, R> =>
    Effect.gen(function* () {
      switch (current) {
        case "startup":
          return `republished ${yield* daemon.republish(projectDirectory(context))}`
        case "open-main": {
          const opened = yield* daemon.openMain(yield* requireDirectory(context))
          return `${opened.action} ${opened.place}`
        }
        case "run": {
          yield* write("Prompt:")
          // shortcut: one line. A multi-line prompt is `vibest run`.
          const prompt = (yield* readLine()).trim()
          if (prompt === "") return yield* new EmptyInput({ message: "the prompt is empty" })
          return `started ${yield* daemon.spawn(yield* requireDirectory(context), prompt)}`
        }
        case "stop": {
          const id = sessionToStop(yield* daemon.list(undefined), context.focusedPaneId, context.focusedPaneAgent)
          if (id === undefined) {
            const where =
              context.focusedPaneId === undefined ? "no focused pane" : `no session in ${context.focusedPaneId}`
            return yield* new NoFocusedSession({ message: where })
          }
          // Stop ends the turn; the session, its pane and its worktree stay (archive is `vibest rm`).
          yield* daemon.interrupt(id)
          return `stopped ${id}`
        }
        case "runs":
          return formatRuns(yield* daemon.list(yield* requireDirectory(context)))
        case "subscriptions":
          return formatUsage(yield* daemon.usage())
        case "palette": {
          const menu = paletteMenu()
          yield* write(menu)
          const picked = actionAt((yield* readLine()).trim())
          if (picked === undefined) return `pick a number from 1 to ${ACTIONS.length}`
          return yield* go(picked[0])
        }
      }
    })
  return go(verb)
}

const claim = (directory: string): Claim => ({ _tag: "cli", repositoryRoot: directory })

const decodeAddress = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeAddress))

const herdrClient = Effect.gen(function* () {
  const socket = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
  if (socket === undefined)
    return yield* new BadPluginContext({ message: "HERDR_SOCKET_PATH is not set; vibest herdr runs inside herdr" })
  const client = yield* Herdr.make(socket)
  yield* Herdr.verifyProtocol(client)
  return client
})

const ask = <A, E, R>(directory: string, f: (client: VibestClient) => Effect.Effect<A, E, R>) =>
  withVibest(claim(directory), f)

const toLive = (session: SessionInfo): LiveSession => ({
  id: session.id,
  agent: session.agent,
  harness: session.harness,
  status: session.status,
  paneId: parseTerminal(session.address)?.paneId,
})

/** The live daemon's steps: vibestd for sessions, this herdr for focus and metadata. The error and service unions
 * below are derived from these methods, so a wrong signature here does not compile. */
const theDaemon = {
  republish: (directory: string | undefined) => ask(directory ?? "/", (client) => client.Republish()),
  openMain: (directory: string) =>
    Effect.gen(function* () {
      const machine = yield* callerMachine()
      // An empty match would hide the main agent when this pane is already it. This id is not a pane.
      const running = yield* ask(directory, (client) =>
        client["Project.RunningCoordinator"]({ terminal: "vibest-open-main" }),
      )
      if (running) {
        const address = yield* decodeAddress(running.address)
        const pane = parseTerminal(address)?.paneId
        if (pane === undefined) return yield* new BadPluginContext({ message: "the main agent has no pane" })
        // shortcut: focus uses the plugin's herdr server; a main agent on another server is not focused.
        yield* (yield* herdrClient).call("pane.focus", { pane_id: pane })
        return { action: "focused" as const, place: pane }
      }
      // The same start path as `vibest`: the main agent's current harness, or what scheduling plugins choose.
      const self = yield* VibestCommand
      const opened = yield* ask(directory, (client) =>
        client.Launch({ argv: [...self], focus: true, machine, runtime: KIND }),
      )
      return { action: "opened" as const, place: opened.place }
    }),
  spawn: (directory: string, prompt: string) =>
    Effect.gen(function* () {
      const machine = yield* callerMachine()
      // No harness: scheduling picks it, as for `vibest run`.
      return (yield* ask(directory, (client) => client.Spawn({ prompt, machine }))).id
    }),
  interrupt: (id: string) => ask("/", (client) => client.Interrupt({ id })).pipe(Effect.asVoid),
  list: (directory: string | undefined) =>
    // No directory: ask for every project's live sessions, not one project's. `/` is the caller header only.
    ask(directory ?? "/", (client) => client.List(directory === undefined ? { all: true } : {})).pipe(
      Effect.map((rows) => rows.filter((row) => row.exitedAt === null).map(toLive)),
    ),
  usage: () =>
    ask("/", (client) => client.Subscriptions()).pipe(
      Effect.map((rows) =>
        rows.flatMap((row) =>
          row.limits.map((limit): UsageWindow => ({
            harness: row.provider === "" ? row.harness : `${row.harness} ${row.provider}`,
            window: limit.window,
            percent: limit.percent,
            status: limit.status,
          })),
        ),
      ),
    ),
}

/** What every live step can fail with, and the services they need: inferred from the methods above. */
type LiveSteps = ReturnType<(typeof theDaemon)[keyof typeof theDaemon]>
export type DaemonError = LiveSteps extends Effect.Effect<any, infer E, any> ? E : never
export type DaemonServices = LiveSteps extends Effect.Effect<any, any, infer R> ? R : never

/** The real daemon. The process that runs the commands provides DaemonServices. */
export const liveDaemon = (): HerdrDaemon<DaemonError, DaemonServices> => theDaemon

/** One line at a time from stdin. Closed when the command finishes so a TTY does not hold the process. */
const stdinLines = () => {
  let reader: readline.Interface | undefined
  const readLine = () =>
    Effect.callback<string>((resume) => {
      reader ??= readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
      let settled = false
      const done = (line: string) => {
        if (settled) return
        settled = true
        reader?.off("line", onLine)
        reader?.off("close", onClose)
        resume(Effect.succeed(line))
      }
      const onLine = (line: string) => done(line)
      const onClose = () => done("")
      reader.once("line", onLine)
      reader.once("close", onClose)
    })
  return { readLine, close: () => reader?.close() }
}

const DESCRIPTIONS: Record<Verb, string> = {
  startup: "Ask vibestd for live sessions and republish their pane metadata",
  "open-main": "Open or focus the main agent of the project in the herdr context",
  run: "Read a prompt from this pane and start a subagent in that project",
  stop: "Stop the session in the focused pane",
  runs: "Print live sessions for the project in the herdr context",
  subscriptions: "Print subscription usage, or unknown when it is not available",
  palette: "A numbered menu of the herdr plugin actions",
}

/** `refuseAgent` is the CLI's user-only check. An agent's `vibest herdr` would run inside its sandbox. */
export const herdrCommands = <E, R>(refuseAgent: (command: string) => Effect.Effect<void, E, R>) =>
  Command.make("herdr").pipe(
    Command.withDescription(
      "Commands the herdr plugin runs. The project directory comes from HERDR_PLUGIN_CONTEXT_JSON, not the working directory.",
    ),
    Command.withSubcommands(
      VERBS.map((verb) =>
        Command.make(verb, {}, () =>
          refuseAgent(`herdr ${verb}`).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const raw = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_PLUGIN_CONTEXT_JSON")))
                if (raw === undefined)
                  return yield* new BadPluginContext({ message: "HERDR_PLUGIN_CONTEXT_JSON is not set" })
                const context = yield* parsePluginContext(raw)
                const io = stdinLines()
                yield* Effect.ensuring(
                  Effect.gen(function* () {
                    const result = yield* perform(verb, context, liveDaemon(), io.readLine, Console.log)
                    if (result !== "") yield* Console.log(result)
                  }),
                  Effect.sync(() => io.close()),
                )
              }),
            ),
          ),
        ).pipe(Command.withDescription(DESCRIPTIONS[verb])),
      ),
    ),
  )
