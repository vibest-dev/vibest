import type * as VibestPlugin from "@vibest/plugin"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"

import type { HerdrPool } from "./pool.ts"
import { parseTerminal } from "./terminal-runtime.ts"

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

export const locate = (
  cli: Cli,
  machine: VibestPlugin.Runtime.Machine,
  sessions: ReadonlyMap<string, string>,
): Effect.Effect<VibestPlugin.Runtime.Located> =>
  Effect.gen(function* () {
    const session = machine.link?.session
    const target = machine.target
    if (session === undefined || target === undefined)
      return { missing: false, terminals: NONE, note: `${machine.id} gave no herdr link` }
    const rows = yield* profiles(cli)
    const profile = mirrorOf(rows, target, session)
    if (profile === undefined) return { missing: true, terminals: NONE }
    if (!profile.enabled)
      return {
        missing: false,
        terminals: NONE,
        as: profile.label,
        note: `herdr here has ${profile.label} disabled; fix: herdr machine enable ${profile.id}`,
      }
    const terminals = new Map<string, Terminal>()
    for (const [id, there] of sessions) {
      const parsed = parseTerminal({ machine: "local", id: there })
      const shown = parsed === undefined ? undefined : mirrorOf(rows, target, parsed.session)
      if (shown?.enabled === true) terminals.set(id, { machine: "local", id: `${there}@${shown.label}` })
    }
    return {
      missing: false,
      terminals,
      as: profile.label,
      ...(terminals.size < sessions.size
        ? { note: `herdr here has no enabled saved machine for that agent's herdr session on ${machine.id}` }
        : {}),
    }
  }).pipe(Effect.catch((note) => Effect.succeed({ missing: false, terminals: NONE, note })))

export const DEFAULT_SESSION = "vibest"

export const link = (pool: HerdrPool["Service"], ambientSocket: string | undefined) =>
  Effect.gen(function* () {
    const session =
      ambientSocket === undefined
        ? DEFAULT_SESSION
        : yield* pool.resolve({ socketPath: ambientSocket }).pipe(Effect.orElseSucceed(() => undefined))
    if (session === undefined) return undefined
    const pong = yield* pool.client(session).pipe(
      Effect.flatMap((h) => h.call("ping", {})),
      Effect.orElseSucceed(() => undefined),
    )
    return {
      session,
      ...(pong === undefined ? {} : { version: pong.version }),
      ...(pong?.capabilities?.detached_server_daemon === false ? { detached: "no" } : {}),
    }
  })
