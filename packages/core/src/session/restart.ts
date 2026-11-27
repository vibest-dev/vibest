import type { HarnessId } from "@vibest/schema/session"
import { PROTOCOL } from "@vibest/schema/version"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Duration, Effect, Exit, Layer, Option, Predicate, Schedule } from "effect"

import { withExecution, type Launch } from "../agent/launch.ts"
import { App } from "../app.ts"
import { awaitEvent, Bus, type BusEvent } from "../bus.ts"
import {
  archived,
  executionStateOf,
  harnessIdOf,
  isRoot,
  pidOf,
  reportedOf,
  runtimeOf,
  type SessionRow,
  terminalOf,
} from "../database/rows.ts"
import { Harnesses } from "../harness/registry.ts"
import { errorMessage } from "../plugin.ts"
import type { HarnessDefinition } from "../plugin/domains.ts"
import { Processes } from "../runtime/processes.ts"
import {
  agentState,
  type AgentSeen,
  peekHint,
  type Runtime,
  Runtimes,
  stateOf,
  type Terminal,
} from "../runtime/registry.ts"
import { SessionLive, type Restarted } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import { Reconcile } from "./reconcile.ts"
import { noticeEnvelope } from "./replies.ts"
import { SessionStore } from "./store.ts"

export * as Restart from "./restart.ts"

export interface Outdated {
  readonly id: string
  readonly agent: string
  readonly harness: HarnessId
  readonly integration: string | null
  readonly working: boolean
  readonly blocked: string | null
}

export const RESTART_TIMEOUT = Duration.seconds(60)
export const AFTER_WAIT = Duration.seconds(10)
export const RESTART_CONCURRENCY = 4

export const CONTINUE =
  "vibest update is done and restarted this agent; do not run it again, continue the interrupted work."

export const continueText = (version: string) => `${CONTINUE} vibest is now ${version}.`

type Integration = { readonly version: string; readonly protocol: number }

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
      readonly integration?: Integration | undefined
    }
  | undefined
>

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const runtimes = yield* Runtimes.Service
  const harnesses = yield* Harnesses.Service
  const processes = yield* Processes.Service
  const { restarting } = yield* SessionLive.Service
  const bus = yield* Bus.Service
  const scope = yield* Effect.scope
  const { locked } = yield* SessionLocks.Service
  const version = (yield* App.Service).version
  const checkLater = (id: string) => Effect.forkIn(reconcile.check(id), scope).pipe(Effect.asVoid)
  const { launching } = yield* Placement.Service
  const reconcile = yield* Reconcile.Service

  const continuing = (interrupted: boolean) => (interrupted ? noticeEnvelope(continueText(version)) : undefined)

  interface Target {
    readonly id: string
    readonly projectId: string
    readonly label: string
    readonly adapter: HarnessDefinition | undefined
    readonly h: Runtime | undefined
    readonly terminal: Terminal
    readonly pid: number | undefined
    readonly harnessSessionId: string | null
    readonly argv: Effect.Effect<(process: number | undefined) => Launch, Effect.Error<ReturnType<typeof launching>>>
    readonly liveNow: LiveNow
    readonly hint: string
    readonly interrupted: boolean
  }

  const current = (integration: Integration | undefined) =>
    integration !== undefined && integration.version === version && integration.protocol === PROTOCOL

  const routed = (kind: string | null | undefined) =>
    kind ? runtimes.route(kind).pipe(Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined)

  const startedAgain = (id: string, liveNow: LiveNow) => {
    const again = liveNow.pipe(
      Effect.map((live) => live?.pid !== undefined && live.ready !== undefined && current(live.integration)),
    )

    const look = Effect.map(again, (yes) => (yes ? Option.some(true) : Option.none()))

    const reported = (event: BusEvent) => {
      if (event.type !== "process.ready" || event.data.sessionId !== id) return false
      const { pid, integration } = event.data

      if (!Predicate.isNumber(pid) || !Predicate.isObjectOrArray(integration)) return false
      const version = "version" in integration ? integration.version : undefined
      const protocol = "protocol" in integration ? integration.protocol : undefined

      return Predicate.isString(version) && Predicate.isNumber(protocol) && current({ version, protocol })
    }

    return awaitEvent(
      look,
      (event) =>
        reported(event)
          ? Effect.succeed(Option.some(true))
          : event.type === "process.ready" && event.data.sessionId === id
            ? look
            : Effect.succeed(Option.none()),
      RESTART_TIMEOUT,
      again,
    ).pipe(Effect.provideService(Bus.Service, bus))
  }

  const inPlace = (t: Target): Effect.Effect<Restarted> => {
    const { id, projectId, label } = t
    const failed = (why: string): Restarted => ({ id, projectId, ok: false, message: `${label} ${why}` })

    return Effect.gen(function* () {
      const blocked = blockedOf(t.adapter, t.h, t.pid, t.harnessSessionId)

      if (blocked !== undefined) return failed(`not restarted: ${blocked}`)
      const h = t.h!
      const pid = t.pid!
      const argv = yield* t.argv

      const signalled = yield* locked(id)(
        Effect.gen(function* () {
          yield* restarting.mark(id)
          const sent = yield* processes.terminate(pid)

          if (sent === "denied") {
            yield* restarting.clear(id)

            return { sent, process: undefined }
          }

          return { sent, process: yield* sessionStore.restartProcess(id) }
        }),
      )

      if (signalled.sent === "denied") return failed(`not restarted: SIGTERM to ${pid} was refused`)
      const ran = yield* h.run!(t.terminal, argv(signalled.process)).pipe(Effect.exit)
      const back = Exit.isSuccess(ran) && (yield* startedAgain(id, t.liveNow))
      yield* restarting.clear(id)

      if (!back)
        return failed(
          Exit.isFailure(ran)
            ? `did not start again: ${errorMessage(ran.cause)}${t.hint}`
            : `did not start again on this vibest within ${Duration.format(RESTART_TIMEOUT)}${t.hint}`,
        )

      return {
        id,
        projectId,
        ok: true,
        message: `${label} restarted${t.interrupted ? "; its interrupted execution continues" : ""}`,
      }
    }).pipe(
      Effect.ensuring(restarting.clear(id).pipe(Effect.andThen(checkLater(id)))),
      Effect.catchCause((cause) => Effect.succeed(failed(`not restarted: ${errorMessage(cause)}`))),
    )
  }

  const againArgv = (session: SessionRow, interrupted: boolean) =>
    Effect.gen(function* () {
      const message = continuing(interrupted)
      const execution = interrupted ? yield* sessionStore.openExecution(session.id) : undefined

      const plan = yield* launching(
        session,
        (session.process?.harnessSessionId ?? null) !== null,
        message === undefined ? undefined : { text: message, onHandover: Effect.void },
      )

      return (process: number | undefined) => withExecution(plan.launch(process), execution)
    })

  const sessionRunning = (session: SessionRow) =>
    Effect.gen(function* () {
      const terminal = terminalOf(session)?.target

      if (terminal === undefined) return undefined
      const h = yield* routed(runtimeOf(session))

      if (h === undefined) return undefined
      const seen = yield* agentState(h, terminal).pipe(Effect.option)

      return Option.isNone(seen) || seen.value === "absent" ? undefined : seen.value
    })

  const restartSession = (id: string, wasWorking: boolean): Effect.Effect<Restarted> =>
    Effect.gen(function* () {
      const session = yield* sessionStore.getSession(id)

      if (session === undefined)
        return { id, projectId: "", ok: false, message: `${id} not restarted: no such session` }
      const terminal = terminalOf(session)?.target

      if (terminal === undefined)
        return { id, projectId: session.projectId, ok: false, message: `${id} not restarted: it has no terminal` }
      const h = yield* routed(runtimeOf(session))

      const seen =
        h === undefined
          ? "unknown"
          : yield* agentState(h, terminal).pipe(Effect.orElseSucceed((): AgentSeen => "unknown"))

      const interrupted = wasWorking || executionStateOf(session) === "open" || stateOf(seen) === "working"

      return yield* inPlace({
        id,
        projectId: session.projectId,
        label: id,
        adapter: harnesses.find(harnessIdOf(session)),
        h,
        terminal,
        pid: pidOf(session),
        harnessSessionId: session.process?.harnessSessionId ?? null,
        argv: againArgv(session, interrupted),
        liveNow: sessionStore.getSession(id).pipe(Effect.map(reportedOf)),
        hint: `; ${peekHint(id)}`,
        interrupted,
      })
    })

  const reports = (harness: HarnessId) => harnesses.find(harness)?.ready === "integration"

  const outdated = Effect.gen(function* () {
    const candidates = (yield* sessionStore.listSessions()).filter(
      (row) =>
        reports(harnessIdOf(row)) &&
        !current(row.process?.integration ?? undefined) &&
        !archived(row) &&
        (row.process?.placedAt ?? null) !== null &&
        terminalOf(row) !== null,
    )

    const listed: Array<Outdated> = []

    for (const row of candidates) {
      let working: boolean | undefined

      if (isRoot(row)) {
        const seen = yield* sessionRunning(row)
        working = seen === undefined ? undefined : stateOf(seen) === "working"
      } else {
        working = executionStateOf(row) === "open"
      }

      if (working === undefined) continue
      const harnessId = harnessIdOf(row)
      listed.push({
        id: row.id,
        agent: row.agent,
        harness: harnessId,
        integration: row.process?.integration?.version ?? null,
        working,
        blocked:
          blockedOf(
            harnesses.find(harnessId),
            yield* routed(runtimeOf(row)),
            pidOf(row),
            row.process?.harnessSessionId ?? null,
          ) ?? null,
      })
    }

    return listed
  })

  const restartOwned = (id: string, working: boolean) => restarting.own(id, restartSession(id, working))

  const restart = Effect.fn("Restart.restart")((ids: ReadonlyArray<string>, working: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(new Set(ids), (id) => restartOwned(id, working.includes(id)), {
        concurrency: RESTART_CONCURRENCY,
      })

      for (const o of outcomes) yield* o.ok ? Effect.logInfo(o.message) : Effect.logWarning(o.message)

      return outcomes
    }),
  )

  const runningTheCommand = (session: SessionRow, command: number) => {
    const pid = pidOf(session)

    return pid === undefined
      ? Effect.succeed(false)
      : processes.tree(pid).pipe(Effect.map((tree) => tree?.includes(command) === true))
  }

  const restartLater = Effect.fn("Restart.restartLater")((ids: ReadonlyArray<string>, after: number | undefined) =>
    Effect.gen(function* () {
      const working: Array<string> = []

      for (const id of ids) {
        const session = yield* sessionStore.getSession(id)

        if (session === undefined) continue

        if (
          stateOf((yield* sessionRunning(session)) ?? "unknown") === "working" ||
          (after !== undefined && (yield* runningTheCommand(session, after)))
        )
          working.push(session.id)
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

      yield* waited.pipe(Effect.andThen(restart(ids, working)), Effect.forkIn(scope))
    }).pipe(Effect.asVoid),
  )

  return { outdated, restart, restartLater }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Restart") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    App.node,
    Bus.node,
    SessionStore.node,
    Harnesses.node,
    Placement.node,
    Processes.node,
    Reconcile.node,
    Runtimes.node,
    SessionLive.node,
    SessionLocks.node,
  ],
})
