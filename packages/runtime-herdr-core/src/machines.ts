import type * as VibestPlugin from "@vibest/plugin/effect"
import { Duration, Effect, type Scope, Stream } from "effect"
import type { api, HcFailure, HcShape } from "effect-herdr-core-sdk"

import { KIND, LABEL, terminalId } from "./terminal-runtime.ts"

type Hc = Pick<HcShape, "call">
type Event = VibestPlugin.MachineEvent
type Terminal = VibestPlugin.Runtime.Terminal

const offline = (e: HcFailure) =>
  e._tag === "HcTransportError" ? `hc here is offline (${e.message})` : `hc here: ${e.message}`

const failed = (e: HcFailure) => `${offline(e)}${e._tag === "HcError" && e.hint ? ` (${e.hint})` : ""}`

const stateNote = (name: string, row: api.MachineView): VibestPlugin.MachineNote => ({
  message: `hc here reaches ${name} as ${row.name}: ${row.state}${row.why ? ` (${row.why})` : ""}`,
  ...(row.state === "needs_login" ? { fix: `hc machine login ${row.name}` } : {}),
})

const addCommand = (event: Event, session: string) =>
  `hc machine add --name ${event.name}${session === "" ? "" : ` --session ${session}`} ${event.target}`

const SETTLE = { tries: 50, every: Duration.millis(200) }

const settled = (hc: Hc, core: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < SETTLE.tries; i++) {
      const row = (yield* hc.call("machine.list", {})).machines.find((r) => r.id === core)
      if (row === undefined || row.state !== "connecting") return
      yield* Effect.sleep(SETTLE.every)
    }
  })

const hcThere = (event: Event) => event.runtimes.find((r) => r.kind === KIND)

export const connect = (hc: Hc, event: Event) => {
  const notes: Array<VibestPlugin.MachineNote> = []
  return Effect.gen(function* () {
    const there = hcThere(event)
    if (there === undefined) return
    const core = there.link?.core
    if (core === undefined) {
      if (there.status !== "online")
        notes.push({
          message: `${event.name}'s hc is ${there.status}${there.reason ? `: ${there.reason}` : ""}`,
        })
      return
    }
    const session = there.link?.session ?? ""
    const rows = (yield* hc.call("machine.list", {})).machines
    const mine = rows.find((row) => row.id === core)
    if (mine !== undefined) {
      if (mine.state !== "connected") notes.push(stateNote(event.name, mine))
      return
    }
    if (session === "") {
      notes.push({
        message: `hc: ${event.name}'s hc runs on a socket of no session, so it is not added here; add it by hand`,
        fix: `hc machine add --name ${event.name} --session <its session> ${event.target}`,
      })
      return
    }
    const add = hc.call("machine.add", { target: event.target, name: event.name, session })
    const added = { message: `hc: added ${event.name} to herdr-core here; herdr-app shows its terminals` }
    const outcome = yield* add.pipe(
      Effect.as("added" as const),
      Effect.catchTag("HcError", (e) => Effect.succeed(e)),
    )
    if (outcome === "added") {
      notes.push(added)
      return yield* settled(hc, core)
    }
    if (outcome.kind === "already_added") return
    const holder = rows.find((row) => row.name === event.name)
    if (outcome.kind !== "name_taken" || holder === undefined) {
      notes.push({ message: failed(outcome), fix: addCommand(event, session) })
      return
    }
    if (holder.target !== event.target || (holder.session ?? "") !== session || holder.state === "connected") {
      notes.push({
        message: `hc here has a machine ${event.name} that is another one`,
        fix: `hc machine rm ${event.name} (or rename it), then ${addCommand(event, session)}`,
      })
      return
    }
    yield* hc.call("machine.rm", { machine: holder.name })
    yield* add
    yield* settled(hc, core)
    notes.push({
      message: `hc: ${event.name}'s core changed (${holder.id.slice(0, 8)} → ${core.slice(0, 8)}); replaced`,
    })
  }).pipe(
    Effect.catch((e) =>
      Effect.sync(() =>
        notes.push({
          message: failed(e),
          fix:
            e._tag === "HcTransportError" ? "hc server start" : addCommand(event, hcThere(event)?.link?.session ?? ""),
        }),
      ),
    ),
    Effect.as(notes),
  )
}

export const remove = (hc: Hc, event: Event) => {
  const notes: Array<VibestPlugin.MachineNote> = []
  return Effect.gen(function* () {
    const there = hcThere(event)
    const core = there?.link?.core
    if (core === undefined && event.runtimes.length > 0 && there === undefined) return
    const rows = (yield* hc.call("machine.list", {})).machines
    const doomed = rows.filter((row) => (core === undefined ? row.target === event.target : row.id === core))
    if (core === undefined && doomed.length > 1) {
      notes.push({
        message: `hc here has ${doomed.length} machines for ${event.target}; remove the right one`,
        fix: "hc machine rm <name>",
      })
      return
    }
    for (const row of doomed)
      yield* hc
        .call("machine.rm", { machine: row.name })
        .pipe(
          Effect.catchTag("HcError", (e) =>
            e.kind === "machine_unknown"
              ? Effect.void
              : Effect.sync(() => notes.push({ message: failed(e), fix: `hc machine rm ${row.name}` })),
          ),
        )
  }).pipe(
    Effect.catch((e) =>
      Effect.sync(() =>
        notes.push({
          message: `${failed(e)}; it may still have ${event.name}`,
          fix: `hc machine rm ${event.name}`,
        }),
      ),
    ),
    Effect.as(notes),
  )
}

const NONE: ReadonlyMap<string, Terminal> = new Map()

export const locate = (
  hc: Hc,
  socket: string,
  peer: VibestPlugin.Runtime.Peer,
  sessions: ReadonlyMap<string, string>,
): Effect.Effect<VibestPlugin.Runtime.Located> =>
  Effect.gen(function* () {
    const core = peer.link.core
    if (core === undefined) return { missing: false, terminals: NONE, note: `${peer.id} gave no hc link` }
    const row = (yield* hc.call("machine.list", {})).machines.find((r) => r.id === core)
    if (row === undefined) return { missing: true, terminals: NONE }
    if (row.state !== "connected") {
      const note = stateNote(peer.id, row)
      return {
        missing: false,
        terminals: NONE,
        as: row.name,
        note: `${note.message}${note.fix ? `; fix: ${note.fix}` : ""}`,
      }
    }
    if (sessions.size === 0) return { missing: false, terminals: NONE, as: row.name }
    const wanted = new Set(sessions.keys())
    const terminals = new Map<string, Terminal>()
    for (const t of (yield* hc.call("terminal.list", { labels: { [LABEL.runtime]: KIND } })).terminals) {
      const session = t.labels[LABEL.session]
      if (t.address.startsWith(`${row.name}/`) && session !== undefined && wanted.has(session))
        terminals.set(session, { id: terminalId(socket, t.address) })
    }
    return {
      missing: false,
      terminals,
      as: row.name,
      ...(terminals.size < wanted.size
        ? { note: `hc here has no terminal of that session under ${row.name}/ (it may have exited there)` }
        : {}),
    }
  }).pipe(
    Effect.catch((e) =>
      Effect.succeed({
        missing: false,
        terminals: NONE,
        note: `${failed(e)}${e._tag === "HcTransportError" ? "; fix: hc server start" : ""}`,
      }),
    ),
  )

export const mirror = (
  machine: VibestPlugin.MachineDomain,
  hc: Hc,
  resets: Stream.Stream<unknown>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const held = new Map<string, Event>()
    yield* machine.hook(
      "connect",
      (event) => Effect.sync(() => held.set(event.name, event)).pipe(Effect.andThen(connect(hc, event))),
      { runtime: KIND },
    )
    yield* machine.hook(
      "remove",
      (event) => Effect.sync(() => held.delete(event.name)).pipe(Effect.andThen(remove(hc, event))),
      { runtime: KIND },
    )
    yield* resets.pipe(
      Stream.runForEach(() =>
        Effect.forEach([...held.values()], (event) => (held.has(event.name) ? connect(hc, event) : Effect.void), {
          discard: true,
        }),
      ),
      Effect.forkScoped,
    )
  })
