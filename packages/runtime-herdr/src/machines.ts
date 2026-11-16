import type * as VibestPlugin from "@vibest/plugin/effect"
import { capture } from "@vibest/plugin/effect"
import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { HerdrPool } from "./pool.ts"
import { parseTerminal, REMOTE_SESSION } from "./terminal-runtime.ts"

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
    capture("herdr", args, { stdin: "ignore", timeout: CLI_TIMEOUT }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.map((run) =>
        run === undefined
          ? { code: 124, stdout: "", stderr: `timed out after ${Duration.format(CLI_TIMEOUT)}` }
          : { code: run.exitCode, stdout: run.stdout, stderr: run.stderr },
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
  peer: VibestPlugin.Runtime.Peer,
  sessions: ReadonlyMap<string, string>,
): Effect.Effect<VibestPlugin.Runtime.Located> =>
  Effect.gen(function* () {
    const session = peer.link.session
    const target = peer.target
    if (session === undefined) return { missing: false, terminals: NONE, note: `${peer.id} gave no herdr link` }
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
      const parsed = parseTerminal({ id: there })
      const shown = parsed === undefined ? undefined : mirrorOf(rows, target, parsed.session)
      if (shown?.enabled === true) terminals.set(id, { id: `${there}@${shown.label}` })
    }
    return {
      missing: false,
      terminals,
      as: profile.label,
      ...(terminals.size < sessions.size
        ? { note: `herdr here has no enabled saved machine for that agent's herdr session on ${peer.id}` }
        : {}),
    }
  }).pipe(Effect.catch((note) => Effect.succeed({ missing: false, terminals: NONE, note })))

export const link = (pool: HerdrPool["Service"]) =>
  Effect.gen(function* () {
    const session = REMOTE_SESSION
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
