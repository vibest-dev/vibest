import type * as VibestPlugin from "@vibest/plugin"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"

import { agentName } from "./terminal-runtime.ts"

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type Cli = (args: ReadonlyArray<string>) => Effect.Effect<Ran>

type Terminal = VibestPlugin.Runtime.Terminal

const CLI_TIMEOUT = Duration.seconds(25)

export const cliOf =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Cli =>
  (args) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("herdr", [...args], { stdin: "ignore" }))
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      return { code: Number(code), stdout: stdout ?? "", stderr: stderr ?? "" }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CLI_TIMEOUT),
      Effect.map(
        Option.getOrElse(() => ({ code: 124, stdout: "", stderr: `timed out after ${Duration.format(CLI_TIMEOUT)}` })),
      ),
      Effect.catch((e) =>
        Effect.succeed({ code: 127, stdout: "", stderr: `herdr: ${e instanceof Error ? e.message : String(e)}` }),
      ),
    )

export const said = (ran: Ran) =>
  (ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.code}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")

const ProfileRow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
})

export type Profile = typeof ProfileRow.Type

const decodeProfiles = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ProfileRow)))

const decodeAgents = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        agents: Schema.Array(
          Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)), pane_id: Schema.String }),
        ),
      }),
    }),
  ),
)

const decodeSessions = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ sessions: Schema.Array(Schema.Struct({ name: Schema.String, socket_path: Schema.String })) }),
  ),
)

export const profiles = (cli: Cli): Effect.Effect<ReadonlyArray<Profile>, string> =>
  Effect.flatMap(cli(["machine", "list", "--json"]), (ran) => {
    const found = ran.code === 0 ? Option.getOrUndefined(decodeProfiles(ran.stdout)) : undefined
    return found === undefined ? Effect.fail(`herdr machine list here: ${said(ran)}`) : Effect.succeed(found)
  })

export const sameTarget = (a: string, b: string) => {
  const plain = (target: string) =>
    target
      .trim()
      .replace(/^ssh:\/\//, "")
      .replace(/\/+$/, "")
  return plain(a) === plain(b)
}

export const mirrorOf = (rows: ReadonlyArray<Profile>, target: string, session: string) =>
  rows.find((row) => sameTarget(row.target, target) && row.session === session)

const NONE: ReadonlyMap<string, Terminal> = new Map()

export const remoteTerminal = (session: string, pane: string, agent: string, label: string) =>
  `${session}/${pane}/${agent}@${label}`

export const locate = (
  cli: Cli,
  machine: VibestPlugin.Runtime.Machine,
  sessions: ReadonlyArray<string>,
): Effect.Effect<VibestPlugin.Runtime.Located> =>
  Effect.gen(function* () {
    const session = machine.link?.session
    if (session === undefined || machine.target === undefined)
      return { missing: false, terminals: NONE, note: `${machine.id} gave no herdr link` }
    const profile = mirrorOf(yield* profiles(cli), machine.target, session)
    if (profile === undefined) return { missing: true, terminals: NONE }
    if (!profile.enabled)
      return {
        missing: false,
        terminals: NONE,
        as: profile.label,
        note: `herdr here has ${profile.label} disabled; fix: herdr machine enable ${profile.id}`,
      }
    if (sessions.length === 0) return { missing: false, terminals: NONE, as: profile.label }
    const ran = yield* cli(["--machine", profile.id, "agent", "list"])
    if (ran.code !== 0)
      return {
        missing: false,
        terminals: NONE,
        as: profile.label,
        note: `herdr here could not list ${profile.label}'s agents: ${said(ran)}`,
      }
    const agents = Option.match(decodeAgents(ran.stdout), { onNone: () => [], onSome: (r) => r.result.agents })
    const panes = new Map(agents.map((agent) => [agent.name, agent.pane_id]))
    const terminals = new Map<string, Terminal>()
    for (const id of sessions) {
      const pane = panes.get(agentName(id))
      if (pane !== undefined)
        terminals.set(id, { machine: "local", id: remoteTerminal(session, pane, agentName(id), profile.label) })
    }
    return {
      missing: false,
      terminals,
      as: profile.label,
      ...(terminals.size < sessions.length
        ? { note: `herdr has no agent of that session on ${profile.label} (it may have exited there)` }
        : {}),
    }
  }).pipe(Effect.catch((note) => Effect.succeed({ missing: false, terminals: NONE, note })))

export const DEFAULT_SESSION = "vibest"

export const link = (cli: Cli, ambientSocket: string | undefined) =>
  Effect.gen(function* () {
    const session =
      ambientSocket === undefined
        ? DEFAULT_SESSION
        : Option.getOrUndefined(decodeSessions((yield* cli(["session", "list", "--json"])).stdout))?.sessions.find(
            (row) => row.socket_path === ambientSocket,
          )?.name
    if (session === undefined) return undefined
    const version = versionOf((yield* cli(["--version"])).stdout)
    return { session, ...(version === undefined ? {} : { version }) }
  })

export const versionOf = (text: string) => /\d+\.\d+\.\d+/.exec(text)?.[0]
