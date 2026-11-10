import type * as VibestPlugin from "@vibest/plugin"
import { Effect, type Scope } from "effect"

import { type Cli, DEFAULT_SESSION, mirrorOf, profiles, said, sameTarget, versionOf } from "./machines.ts"
import { KIND } from "./terminal-runtime.ts"

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

export const connect = (cli: Cli, event: Event) =>
  Effect.gen(function* () {
    const there = herdrThere(event)
    if (there === undefined) return
    const session = there.link?.session
    if (session === undefined) {
      if (there.status !== "online")
        event.notes.push({
          message: `${event.name}'s herdr is ${there.status}${there.reason ? `: ${there.reason}` : ""}`,
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
    const ours = versionOf((yield* cli(["--version"])).stdout)
    if (ours !== undefined && older(ours, MINIMUM_VERSION)) {
      event.notes.push({
        message: `herdr ${ours} here cannot show other machines (herdr ${MINIMUM_VERSION} or newer is needed)`,
        fix: "herdr update",
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
        fix: `herdr machine rename ${holder.id} --label <another label>, then herdr ${addArgs(event, session).join(" ")}`,
      })
      return
    }
    const added = yield* cli(addArgs(event, session))
    event.notes.push(
      added.code === 0
        ? { message: `herdr: added ${label} here; the herdr sidebar shows its agents` }
        : {
            message: `herdr here could not add ${label}: ${said(added)}`,
            fix: `herdr ${addArgs(event, session).join(" ")}`,
          },
    )
  }).pipe(Effect.catch((message) => Effect.sync(() => void event.notes.push({ message }))))

export const remove = (cli: Cli, event: Event) =>
  Effect.gen(function* () {
    const there = herdrThere(event)
    if (there === undefined && event.runtimes.length > 0) return
    const session = there?.link?.session ?? DEFAULT_SESSION
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
