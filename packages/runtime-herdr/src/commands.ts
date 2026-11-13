import readline from "node:readline"

import { type Claim, type VibestClient, withVibest } from "@vibest/client/client"
import { isLimited } from "@vibest/plugin"
import type { SessionInfo } from "@vibest/protocol/rpc"
import { shortId } from "@vibest/schema/id"
import { VibestCommand } from "@vibest/schema/layout"
import { Config, Console, Effect, Option, Schema } from "effect"
import { Command } from "effect/cli"

import { agentName, KIND, parseTerminal } from "./terminal-runtime.ts"

export class BadPluginContext extends Schema.TaggedError<BadPluginContext>()("BadPluginContext", {
  message: Schema.String,
}) {}

export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

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
  readonly resetTime: number | null
  readonly error?: string
}

type Step<A, E, R> = Effect.Effect<A, E, R>

export interface HerdrDaemon<E = never, R = never> {
  readonly republish: (directory: string | undefined) => Step<number, E, R>
  readonly openEntry: (
    directory: string,
  ) => Step<{ readonly action: "focused" | "runs in" | "opened"; readonly place: string }, E, R>
  readonly spawn: (directory: string, prompt: string) => Step<string, E, R>
  readonly interrupt: (id: string) => Step<void, E, R>
  readonly list: (directory: string | undefined) => Step<ReadonlyArray<LiveSession>, E, R>
  readonly usage: () => Step<ReadonlyArray<UsageWindow> | undefined, E, R>
}

const field = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)

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
    .map((session) =>
      [shortId(session.id), session.agent, session.harness, session.status, session.paneId ?? "-"].join("  "),
    )
    .join("\n")
}

export const formatUsage = (usage: ReadonlyArray<UsageWindow> | undefined) => {
  if (usage === undefined || usage.length === 0) return "unknown"
  return usage
    .map((window) => {
      const status = isLimited({ limits: [window] }) ? "limited" : "available"
      const error = window.error ? `  ${window.error}` : ""
      return `${window.harness}  ${window.window}  ${window.percent}%  ${status}${error}`
    })
    .join("\n")
}

export const sessionToStop = (
  sessions: ReadonlyArray<LiveSession>,
  paneId: string | undefined,
  agent: string | undefined,
) => {
  const byPane = paneId === undefined ? undefined : sessions.find((session) => session.paneId === paneId)
  if (byPane) return byPane.id
  return agent === undefined ? undefined : sessions.find((session) => agentName(session.id) === agent)?.id
}

export const ACTIONS = [
  ["open-entry", "Open or focus the entry session"],
  ["run", "Run a subagent"],
  ["stop", "Stop the session in the focused pane"],
  ["runs", "List live sessions"],
  ["subscriptions", "Subscription usage"],
] as const

export const paletteMenu = () => ACTIONS.map(([id, title], index) => `${index + 1}  ${id}  ${title}`).join("\n")

export const VERBS = ["startup", "open-entry", "run", "stop", "runs", "subscriptions", "palette"] as const
export type Verb = (typeof VERBS)[number]

const actionAt = (choice: string) => {
  if (!/^[1-9][0-9]*$/.test(choice)) return undefined
  const index = Number(choice)
  return index <= ACTIONS.length ? ACTIONS[index - 1] : undefined
}

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
        case "open-entry": {
          const opened = yield* daemon.openEntry(yield* requireDirectory(context))
          return `${opened.action} ${opened.place}`
        }
        case "run": {
          yield* write("Prompt:")
          const prompt = (yield* readLine()).trim()
          if (prompt === "") return yield* new EmptyInput({ message: "the prompt is empty" })
          return `started ${shortId(yield* daemon.spawn(yield* requireDirectory(context), prompt))}`
        }
        case "stop": {
          const id = sessionToStop(yield* daemon.list(undefined), context.focusedPaneId, context.focusedPaneAgent)
          if (id === undefined) {
            const where =
              context.focusedPaneId === undefined ? "no focused pane" : `no session in ${context.focusedPaneId}`
            return yield* new NoFocusedSession({ message: where })
          }
          yield* daemon.interrupt(id)
          return `stopped ${shortId(id)}`
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

const callerEnvOf = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const ask = <A, E, R>(directory: string, f: (client: VibestClient) => Effect.Effect<A, E, R>) =>
  withVibest(claim(directory), f)

const toLive = (session: SessionInfo): LiveSession => ({
  id: session.id,
  agent: session.agent,
  harness: session.harness,
  status: session.status,
  paneId: parseTerminal(session.address)?.paneId,
})

const theDaemon = {
  republish: (directory: string | undefined) => ask(directory ?? "/", (client) => client.Republish()),
  openEntry: (directory: string) =>
    Effect.gen(function* () {
      const focused = yield* ask(directory, (client) => client["Project.FocusEntry"]({}))
      if (focused)
        return { action: focused.focused ? ("focused" as const) : ("runs in" as const), place: focused.place }
      const self = yield* VibestCommand
      const opened = yield* ask(directory, (client) =>
        client.Launch({ argv: [...self], agent: "coordinator", focus: true, runtime: KIND, callerEnv: callerEnvOf() }),
      )
      return { action: "opened" as const, place: opened.place }
    }),
  spawn: (directory: string, prompt: string) =>
    Effect.gen(function* () {
      return (yield* ask(directory, (client) => client.Spawn({ prompt, agent: "general", callerEnv: callerEnvOf() })))
        .id
    }),
  interrupt: (id: string) => ask("/", (client) => client.Interrupt({ id })).pipe(Effect.asVoid),
  list: (directory: string | undefined) =>
    ask(directory ?? "/", (client) => client.List(directory === undefined ? { all: true } : {})).pipe(
      Effect.map((listed) =>
        listed.sessions.filter((row) => row.exitedAt === null && row.machine === undefined).map(toLive),
      ),
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
            resetTime: limit.resetTime,
            ...(row.error ? { error: row.error } : {}),
          })),
        ),
      ),
    ),
}

type LiveSteps = ReturnType<(typeof theDaemon)[keyof typeof theDaemon]>
export type DaemonError = LiveSteps extends Effect.Effect<any, infer E, any> ? E : never
export type DaemonServices = LiveSteps extends Effect.Effect<any, any, infer R> ? R : never

export const liveDaemon = (): HerdrDaemon<DaemonError, DaemonServices> => theDaemon

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
  "open-entry": "Open or focus the entry session of the project in the herdr context",
  run: "Read a prompt from this pane and start a subagent in that project",
  stop: "Stop the session in the focused pane",
  runs: "Print live sessions for the project in the herdr context",
  subscriptions: "Print subscription usage, or unknown when it is not available",
  palette: "A numbered menu of the herdr plugin actions",
}

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
