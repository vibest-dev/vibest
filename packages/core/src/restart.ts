import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { Duration, Effect, Exit, Fiber, Option, Schedule, type Scope } from "effect"

import { awaitEvent, Bus, type EngineEvent } from "./bus.ts"
import type { CoordinatorRow, Db, SessionRow } from "./db.ts"
import type { HarnessId } from "./harness.ts"
import type { HarnessDefinition, HarnessesShape } from "./host.ts"
import type { Inbox } from "./inbox.ts"
import { errorMessage } from "./plugins.ts"
import type { Processes } from "./processes.ts"
import type { Restarting } from "./restarting.ts"
import {
  agentState,
  type AgentSeen,
  peekHint,
  type Runtime,
  type Runtimes,
  stateOf,
  type Terminal,
} from "./runtimes.ts"

export interface Outdated {
  readonly id: string
  readonly agent: string
  readonly harness: HarnessId
  readonly integration: string | null
  readonly working: boolean
  readonly blocked: string | null
}
export interface Restarted {
  readonly id: string
  readonly projectId: string
  readonly ok: boolean
  readonly message: string
}

export const RESTART_TIMEOUT = Duration.seconds(60)
export const AFTER_WAIT = Duration.seconds(10)
export const RESTART_CONCURRENCY = 4
export const CONTINUE =
  "vibest update is done and restarted this agent; do not run it again, continue the interrupted work."

export const continueText = (version: string) => `${CONTINUE} vibest is now ${version}.`

export const continueNotice = (version: string, restarted: ReadonlyArray<Restarted>) =>
  [
    CONTINUE,
    `vibest is now ${version}.`,
    ...(restarted.some((r) => r.ok)
      ? [
          `Restarted: ${restarted
            .filter((r) => r.ok)
            .map((r) => r.id)
            .join(", ")}.`,
        ]
      : []),
    ...restarted.filter((r) => !r.ok).map((r) => r.message),
  ].join("\n")

export const current = (integration: { readonly version: string; readonly protocol: number } | undefined) =>
  integration !== undefined && integration.version === VERSION && integration.protocol === PROTOCOL

export const blockedOf = (
  adapter: HarnessDefinition | undefined,
  h: Runtime | undefined,
  pid: number | undefined,
  harnessSessionId: string | null,
) =>
  adapter === undefined
    ? "no loaded plugin provides its harness; load one, or quit it and start it again yourself"
    : adapter.ready !== "integration"
      ? "its harness has no integration that reports its pid and when it is ready; quit it and start it again yourself"
      : h?.run === undefined
        ? "its runtime cannot start a program in its terminal again; quit it and start it again yourself"
        : pid === undefined
          ? "its harness never reported its pid; quit it and start it again yourself"
          : harnessSessionId === null
            ? "its conversation id is not known, so a restart would start a new conversation"
            : undefined

const UPDATE_CLI_EXIT_POLL = Schedule.spaced("500 millis")

type LiveNow = Effect.Effect<
  | {
      readonly pid?: number | undefined
      readonly ready?: number | undefined
      readonly integration?: Parameters<typeof current>[0]
    }
  | undefined
>

interface Target {
  readonly id: string
  readonly projectId: string
  readonly label: string
  readonly adapter: HarnessDefinition | undefined
  readonly h: Runtime | undefined
  readonly terminal: Terminal
  readonly pid: number | undefined
  readonly harnessSessionId: string | null
  readonly interrupted: boolean
  readonly argv: Effect.Effect<ReadonlyArray<string>, unknown>
  readonly liveNow: LiveNow
  readonly locked: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly hint: string
  readonly onBack: (h: Runtime) => Effect.Effect<Restarted, unknown>
  readonly reconcile: Effect.Effect<void>
}

export const sessionRestart = (deps: {
  readonly db: Db["Service"]
  readonly bus: Bus["Service"]
  readonly runtimes: Runtimes["Service"]
  readonly harnesses: Pick<HarnessesShape, "get" | "find">
  readonly processes: Processes["Service"]
  readonly restarting: Restarting["Service"]
  readonly inbox: Inbox["Service"]
  readonly scope: Scope.Scope
  readonly locked: (id: string) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly checkLater: (id: string) => Effect.Effect<void>
  readonly launchArgv: (session: SessionRow, resume: boolean) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly mainArgv: (main: CoordinatorRow) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly awaitReady: (
    h: Runtime,
    terminal: Terminal,
    adapter: HarnessDefinition,
    id: string,
  ) => Effect.Effect<unknown, unknown>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
  ) => Effect.Effect<string | undefined, unknown>
}) => {
  const { db, runtimes, harnesses, processes, inbox } = deps

  const routed = (kind: string | null | undefined) =>
    kind ? runtimes.route(kind).pipe(Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined)

  const startedAgain = (id: string, liveNow: LiveNow) => {
    const again = liveNow.pipe(
      Effect.map((live) => live?.pid !== undefined && live.ready !== undefined && current(live.integration)),
    )
    const look = Effect.map(again, (yes) => (yes ? Option.some(true) : Option.none()))
    const reported = (event: EngineEvent) => {
      if (event.type !== "process.ready" || event.sessionId !== id) return false
      const { pid, integration } = event.data
      if (typeof pid !== "number" || typeof integration !== "object" || integration === null) return false
      const version = "version" in integration ? integration.version : undefined
      const protocol = "protocol" in integration ? integration.protocol : undefined
      return typeof version === "string" && typeof protocol === "number" && current({ version, protocol })
    }
    return awaitEvent(
      look,
      (event) =>
        reported(event)
          ? Effect.succeed(Option.some(true))
          : event.type === "process.ready" && event.sessionId === id
            ? look
            : Effect.succeed(Option.none()),
      RESTART_TIMEOUT,
      again,
    ).pipe(Effect.provideService(Bus, deps.bus))
  }

  const inPlace = (t: Target): Effect.Effect<Restarted> => {
    const { id, projectId, label } = t
    const failed = (why: string): Restarted => ({ id, projectId, ok: false, message: `${label} ${why}` })
    return Effect.gen(function* () {
      const blocked = blockedOf(t.adapter, t.h, t.pid, t.harnessSessionId)
      if (blocked !== undefined) return failed(`not restarted: ${blocked}`)
      const h = t.h!
      const adapter = t.adapter!
      const pid = t.pid!
      const argv = yield* t.argv
      const signalled = yield* t.locked(
        Effect.gen(function* () {
          yield* deps.restarting.mark(id)
          const sent = yield* processes.terminate(pid)
          if (sent === "denied") yield* deps.restarting.clear(id)
          else yield* db.restartProcess(id)
          return sent
        }),
      )
      if (signalled === "denied") return failed(`not restarted: SIGTERM to ${pid} was refused`)
      const ran = yield* h.run!(t.terminal, argv).pipe(Effect.exit)
      const cameBack = yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startedAgain(id, t.liveNow).pipe(Effect.forkScoped)
          const ready = yield* deps.awaitReady(h, t.terminal, adapter, id).pipe(Effect.option, Effect.forkScoped)
          return (yield* Fiber.join(started)) && Option.isSome(yield* Fiber.join(ready))
        }),
      )
      const back = Exit.isSuccess(ran) && cameBack
      return yield* t.locked(
        Effect.gen(function* () {
          yield* deps.restarting.clear(id)
          if (!back)
            return failed(
              Exit.isFailure(ran)
                ? `did not start again: ${errorMessage(ran.cause)}${t.hint}`
                : `did not start again on this vibest within ${Duration.format(RESTART_TIMEOUT)}${t.hint}`,
            )
          return yield* t.onBack(h)
        }),
      )
    }).pipe(
      Effect.ensuring(deps.restarting.clear(id).pipe(Effect.andThen(t.reconcile))),
      Effect.catchCause((cause) => Effect.succeed(failed(`not restarted: ${errorMessage(cause)}`))),
    )
  }

  const againArgv = (session: SessionRow) => deps.launchArgv(session, session.harnessSessionId !== null)

  const restartAgent = (id: string): Effect.Effect<Restarted> =>
    Effect.gen(function* () {
      const session = yield* db.getSession(id)
      if (session === undefined)
        return { id, projectId: "", ok: false, message: `${id} not restarted: no such session` }
      const interrupted = session.executionState === "open"
      return yield* inPlace({
        id,
        projectId: session.projectId,
        label: id,
        adapter: harnesses.find(session.harnessId),
        h: yield* routed(session.runtime),
        terminal: session.address,
        pid: session.metadata.pid,
        harnessSessionId: session.harnessSessionId,
        interrupted,
        argv: againArgv(session),
        liveNow: db.getSession(id).pipe(Effect.map((row) => row?.metadata)),
        locked: deps.locked(id),
        reconcile: deps.checkLater(id),
        hint: `; ${peekHint(id)}`,
        onBack: (h) =>
          Effect.gen(function* () {
            const projectId = session.projectId
            if (!interrupted) return { id, projectId, ok: true, message: `${id} restarted` }
            const missed = yield* deps.prompt(
              h,
              (yield* db.getSession(id)) ?? session,
              session.address,
              continueText(VERSION),
            )
            return missed === undefined
              ? { id, projectId, ok: true, message: `${id} restarted; its interrupted execution continues` }
              : { id, projectId, ok: false, message: `${id} restarted, but ${missed}` }
          }),
      })
    })

  const restartMain = (main: CoordinatorRow, before: ReadonlyArray<Restarted>, wasWorking: boolean) =>
    Effect.gen(function* () {
      const { id, projectId } = main
      const label = `${id} (main agent)`
      if (!main.runtime || !main.address || main.address.id === "")
        return { id, projectId, ok: false, message: `${label} not restarted: it has no terminal` } satisfies Restarted
      const h = yield* routed(main.runtime)
      const seen =
        h === undefined
          ? "unknown"
          : yield* agentState(h, main.address).pipe(Effect.orElseSucceed((): AgentSeen => "unknown"))
      const interrupted = wasWorking || stateOf(seen) === "working"
      return yield* inPlace({
        id,
        projectId,
        label,
        adapter: harnesses.find(main.harnessId),
        h,
        terminal: main.address,
        pid: main.pid,
        harnessSessionId: main.harnessSessionId,
        interrupted,
        argv: deps.mainArgv(main),
        liveNow: Effect.gen(function* () {
          const row = yield* db.coordinatorOf(projectId)
          return row?.id === id ? { ...row, ready: yield* db.readyAt(id) } : undefined
        }),
        locked: (effect) => effect,
        reconcile: Effect.forkIn(inbox.deliver(projectId), deps.scope).pipe(Effect.asVoid),
        hint: "",
        onBack: () =>
          Effect.gen(function* () {
            const restarted: Restarted = {
              id,
              projectId,
              ok: true,
              message: `${label} restarted${interrupted ? "; its interrupted execution continues" : ""}`,
            }
            if (interrupted)
              yield* inbox.enqueue({
                sessionId: id,
                message: continueNotice(VERSION, [...before.filter((r) => r.projectId === projectId), restarted]),
              })
            return restarted
          }),
      })
    })

  const mainRunning = (main: CoordinatorRow) =>
    Effect.gen(function* () {
      if (!main.runtime || !main.address || main.address.id === "") return undefined
      const h = yield* routed(main.runtime)
      if (h === undefined) return undefined
      const seen = yield* agentState(h, main.address).pipe(Effect.option)
      return Option.isNone(seen) || seen.value === "absent" ? undefined : seen.value
    })

  const reports = (harness: HarnessId) => harnesses.find(harness)?.ready === "integration"

  const outdated = Effect.gen(function* () {
    const agents = (yield* db.listSessions()).filter(
      (row) =>
        reports(row.harnessId) &&
        !current(row.metadata.integration) &&
        !(row.metadata.archived || row.metadata.removed) &&
        row.startedAt !== null &&
        row.address.id !== "",
    )
    const mains: Array<Outdated> = []
    for (const main of yield* db.coordinators) {
      if (!reports(main.harnessId) || current(main.integration)) continue
      const seen = yield* mainRunning(main)
      if (seen === undefined) continue
      mains.push({
        id: main.id,
        agent: "main",
        harness: main.harnessId,
        integration: main.integration?.version ?? null,
        working: stateOf(seen) === "working",
        blocked:
          blockedOf(harnesses.find(main.harnessId), yield* routed(main.runtime), main.pid, main.harnessSessionId) ??
          null,
      })
    }
    const subs: Array<Outdated> = []
    for (const row of agents)
      subs.push({
        id: row.id,
        agent: row.agent,
        harness: row.harnessId,
        integration: row.metadata.integration?.version ?? null,
        working: row.executionState === "open",
        blocked:
          blockedOf(
            harnesses.find(row.harnessId),
            yield* routed(row.runtime),
            row.metadata.pid,
            row.harnessSessionId,
          ) ?? null,
      })
    return [...subs, ...mains]
  })

  const restart = (ids: ReadonlyArray<string>, working: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const mains = (yield* db.coordinators).filter((main) => ids.includes(main.id))
      const agents = ids.filter((id) => !mains.some((main) => main.id === id))
      const first = yield* Effect.forEach(agents, restartAgent, { concurrency: RESTART_CONCURRENCY })
      const last = yield* Effect.forEach(mains, (main) => restartMain(main, first, working.includes(main.id)))
      const outcomes = [...first, ...last]
      for (const o of outcomes) yield* o.ok ? Effect.logInfo(o.message) : Effect.logWarning(o.message)
      return outcomes
    })

  const runningTheCommand = (main: CoordinatorRow, command: number) =>
    main.pid === undefined
      ? Effect.succeed(false)
      : processes.tree(main.pid).pipe(Effect.map((tree) => tree?.includes(command) === true))

  const restartLater = (ids: ReadonlyArray<string>, after: number | undefined) =>
    Effect.gen(function* () {
      const working: Array<string> = []
      for (const main of yield* db.coordinators) {
        if (!ids.includes(main.id)) continue
        if (
          stateOf((yield* mainRunning(main)) ?? "unknown") === "working" ||
          (after !== undefined && (yield* runningTheCommand(main, after)))
        )
          working.push(main.id)
      }
      const waited =
        after === undefined
          ? Effect.void
          : processes
              .liveness(after)
              .pipe(
                Effect.repeat({ until: (l) => l !== "alive", schedule: UPDATE_CLI_EXIT_POLL }),
                Effect.timeoutOption(AFTER_WAIT),
              )
      yield* waited.pipe(Effect.andThen(restart(ids, working)), Effect.forkIn(deps.scope))
    }).pipe(Effect.asVoid)

  return { outdated, restart, restartLater }
}
