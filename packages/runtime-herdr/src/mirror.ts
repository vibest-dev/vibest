import type * as VibestPlugin from "@vibest/plugin"
import { Duration, Effect, Option, type Scope } from "effect"

import { type Cli, mirrorOf, profiles, said, sameTarget } from "./machines.ts"
import { KIND, REMOTE_SESSION } from "./terminal-runtime.ts"

type Event = VibestPlugin.MachineEvent

const labelFor = (name: string, session: string) => `${name}/${session}`

export const MINIMUM_VERSION = "0.9.5"

export const older = (version: string, than: string) => {
  const parts = (v: string) => v.split(".").map(Number)
  const [a, b] = [parts(version), parts(than)]
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!
  return false
}

const herdrThere = (event: Event) => event.runtimes.find((r) => r.kind === KIND)

const addArgs = (event: Event, session: string) => [
  "machine",
  "add",
  event.target,
  "--label",
  labelFor(event.name, session),
  "--remote-session",
  session,
]

const CONNECT_BUDGET = Duration.seconds(25)

export const connect = (cli: Cli, event: Event) =>
  Effect.gen(function* () {
    const there = herdrThere(event)
    if (there === undefined) return
    const session = there.link?.session
    if (session === undefined) {
      event.notes.push({
        message:
          there.status === "online"
            ? `${event.name}'s herdr is online but its vibestd named no herdr session, so its agents cannot be shown here`
            : `${event.name}'s herdr is ${there.status}${there.reason ? `: ${there.reason}` : ""}`,
      })
      return
    }
    const theirs = there.link?.version
    if (theirs !== undefined && older(theirs, MINIMUM_VERSION)) {
      event.notes.push({
        message: `${event.name}'s herdr ${theirs} cannot be viewed from here (herdr ${MINIMUM_VERSION} or newer is needed)`,
        fix: `herdr update (on ${event.name})`,
      })
      return
    }
    const rows = yield* profiles(cli)
    const mine = mirrorOf(rows, event.target, session)
    const label = labelFor(event.name, session)
    if (mine !== undefined) {
      if (!mine.enabled)
        event.notes.push({
          message: `herdr here has ${mine.label} disabled`,
          fix: `herdr machine enable ${mine.id}`,
        })
      return
    }
    const holder = rows.find((row) => row.label === label)
    if (holder !== undefined) {
      event.notes.push({
        message: `herdr here has a machine ${label} that is another one`,
        fix: `herdr machine rename ${holder.id} --label <another label>, then vibest machine ls`,
      })
      return
    }
    const added = yield* cli(addArgs(event, session))
    event.notes.push({
      message:
        added.code === 0
          ? `herdr: added ${label} here; the herdr sidebar shows its agents`
          : `herdr here could not add ${label}: ${said(added)}${
              there.link?.detached === "no"
                ? `; ${event.name}'s herdr session ${session} was not started as its own session leader, which herdr does not save as a machine: restart that session on ${event.name} once no agent runs there`
                : ""
            }`,
    })
  }).pipe(
    Effect.timeoutOption(CONNECT_BUDGET),
    Effect.map(
      Option.match({
        onNone: () =>
          void event.notes.push({
            message: `herdr here took over ${Duration.format(CONNECT_BUDGET)} to add ${event.name}; herdr machine list shows whether it did`,
          }),
        onSome: () => undefined,
      }),
    ),
    Effect.catch((message) => Effect.sync(() => void event.notes.push({ message }))),
  )

export const remove = (cli: Cli, event: Event) =>
  Effect.gen(function* () {
    const there = herdrThere(event)
    if (there === undefined && event.runtimes.length > 0) return
    const session = there?.link?.session ?? REMOTE_SESSION
    const doomed = (yield* profiles(cli)).filter(
      (row) => sameTarget(row.target, event.target) && row.session === session,
    )
    if (doomed.length > 1) {
      event.notes.push({
        message: `herdr here has ${doomed.length} machines for ${event.target} session ${session}; remove the right one`,
        fix: "herdr machine remove <profile-id>",
      })
      return
    }
    for (const row of doomed) {
      const removed = yield* cli(["machine", "remove", row.id])
      if (removed.code !== 0)
        event.notes.push({
          message: `herdr here could not remove ${row.label}: ${said(removed)}`,
          fix: `herdr machine remove ${row.id}`,
        })
    }
  }).pipe(
    Effect.catch((message) =>
      Effect.sync(() => void event.notes.push({ message: `${message}; it may still have ${event.name}` })),
    ),
  )

export const mirror = (machine: VibestPlugin.MachineDomain, cli: Cli): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* machine.hook("connect", (event) => connect(cli, event), { runtime: KIND })
    yield* machine.hook("remove", (event) => remove(cli, event), { runtime: KIND })
  })
