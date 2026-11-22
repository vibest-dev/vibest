import { Layout, VibestCommand } from "@vibest/schema/layout"
import type { HarnessId } from "@vibest/schema/session"
import { PROTOCOL } from "@vibest/schema/version"
import { Context, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Predicate, Schedule } from "effect"

import { Agents } from "../agents.ts"
import { App } from "../app.ts"
import { awaitEvent, Bus, type BusEvent } from "../bus.ts"
import {
  archived,
  executionStateOf,
  harnessIdOf,
  pidOf,
  placedTerminal,
  reportedOf,
  runtimeOf,
  type SessionRow,
  terminalOf,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Harness } from "../harness.ts"
import { Harnesses } from "../harnesses.ts"
import { entryCommand, withProcess, type Launch } from "../launch.ts"
import { errorMessage } from "../plugin.ts"
import type { HarnessDefinition } from "../plugin/domains.ts"
import { Processes } from "../processes.ts"
import { noticeEnvelope } from "../replies.ts"
import { agentState, type AgentSeen, peekHint, type Runtime, Runtimes, stateOf, type Terminal } from "../runtimes.ts"
import { SessionLive, type Restarted } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement, runtimeEnv } from "./placement.ts"
import { Reconcile } from "./reconcile.ts"

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
  const db = yield* Db.Service
  const runtimes = yield* Runtimes.Service
  const harness = yield* Harness.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processes = yield* Processes.Service
  const { restarting } = yield* SessionLive.Service
  const bus = yield* Bus.Service
  const scope = yield* Effect.scope
  const { locked } = yield* SessionLocks.Service
  const version = (yield* App.Service).version
  const checkLater = (id: string) => Effect.forkIn(reconcile.check(id), scope).pipe(Effect.asVoid)
  const { launching } = yield* Placement.Service
  const reconcile = yield* Reconcile.Service
  const vibestCommand = yield* VibestCommand

  const continuing = (interrupted: boolean) => (interrupted ? noticeEnvelope(continueText(version)) : undefined)

  const entryArgv = (entry: SessionRow, interrupted: boolean) =>
    Effect.gen(function* () {
      yield* db.session.patchLive(entry.id, { ready: null })

      const root =
        (yield* db.project.projectDirectory(entry.projectId)) || (yield* db.session.sessionDirectory(entry.id)) || ""

      const savedId = entry.process?.harnessSessionId ?? null
      const place = placedTerminal(entry)

      const command = yield* entryCommand({
        harness: harnessIdOf(entry),
        agent: entry.agent,
        root,
        provider: entry.process?.provider ?? null,
        model: entry.process?.model ?? null,
        session: Effect.succeed({
          sessionId: entry.id,
          harnessSessionId:
            savedId !== null && (yield* db.session.canResumeConversation(entry.id, savedId)) ? savedId : null,
          projectId: entry.projectId,
          ...(place !== undefined && { runtime: runtimeEnv(place.runtime, place.address) }),
        }),
        message: continuing(interrupted),
      })

      return (process: number | undefined) => withProcess(command, process)
    }).pipe(
      Effect.provideService(Agents.Service, agents),
      Effect.provideService(Harness.Service, harness),
      Effect.provideService(Harnesses.Service, harnesses),
      Effect.provideService(Layout, layout),
      Effect.provideService(VibestCommand, vibestCommand),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )

  interface Target {
    readonly id: string
    readonly projectId: string
    readonly label: string
    readonly adapter: HarnessDefinition | undefined
    readonly h: Runtime | undefined
    readonly terminal: Terminal
    readonly pid: number | undefined
    readonly harnessSessionId: string | null
    readonly argv: Effect.Effect<
      (process: number | undefined) => Launch,
      Effect.Error<ReturnType<typeof entryArgv>> | Effect.Error<ReturnType<typeof launching>>
    >
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
      if (event.type !== "process.ready" || event.sessionId !== id) return false
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
          : event.type === "process.ready" && event.sessionId === id
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

          return { sent, process: yield* db.session.restartProcess(id) }
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

  const againArgv = (session: SessionRow, interrupted: boolean) => {
    const message = continuing(interrupted)

    return Effect.map(
      launching(
        session,
        (session.process?.harnessSessionId ?? null) !== null,
        message === undefined ? undefined : { text: message, onHandover: Effect.void },
      ),
      (plan) => plan.launch,
    )
  }

  const restartAgent = (id: string): Effect.Effect<Restarted> =>
    Effect.gen(function* () {
      const session = yield* db.session.getSession(id)

      if (session === undefined)
        return { id, projectId: "", ok: false, message: `${id} not restarted: no such session` }
      const interrupted = executionStateOf(session) === "open"

      return yield* inPlace({
        id,
        projectId: session.projectId,
        label: id,
        adapter: harnesses.find(harnessIdOf(session)),
        h: yield* routed(runtimeOf(session)),
        terminal: terminalOf(session),
        pid: pidOf(session),
        harnessSessionId: session.process?.harnessSessionId ?? null,
        argv: againArgv(session, interrupted),
        liveNow: db.session.getSession(id).pipe(Effect.map(reportedOf)),
        hint: `; ${peekHint(id)}`,
        interrupted,
      })
    })

  const restartEntry = (entry: SessionRow, wasWorking: boolean) =>
    Effect.gen(function* () {
      const { id, projectId } = entry
      const label = `${id} (entry session)`
      const place = placedTerminal(entry)

      if (place === undefined)
        return { id, projectId, ok: false, message: `${label} not restarted: it has no terminal` } satisfies Restarted
      const h = yield* routed(place.runtime)

      const seen =
        h === undefined
          ? "unknown"
          : yield* agentState(h, place.address).pipe(Effect.orElseSucceed((): AgentSeen => "unknown"))

      const interrupted = wasWorking || stateOf(seen) === "working"

      return yield* inPlace({
        id,
        projectId,
        label,
        adapter: harnesses.find(harnessIdOf(entry)),
        h,
        terminal: place.address,
        pid: pidOf(entry),
        harnessSessionId: entry.process?.harnessSessionId ?? null,
        argv: entryArgv(entry, interrupted),
        liveNow: Effect.gen(function* () {
          const row = yield* db.session.entryOf(projectId)

          return row?.id === id ? reportedOf(row) : undefined
        }),
        hint: "",
        interrupted,
      })
    })

  const entryRunning = (entry: SessionRow) =>
    Effect.gen(function* () {
      const place = placedTerminal(entry)

      if (place === undefined) return undefined
      const h = yield* routed(place.runtime)

      if (h === undefined) return undefined
      const seen = yield* agentState(h, place.address).pipe(Effect.option)

      return Option.isNone(seen) || seen.value === "absent" ? undefined : seen.value
    })

  const reports = (harness: HarnessId) => harnesses.find(harness)?.ready === "integration"

  const outdated = Effect.gen(function* () {
    const sessions = (yield* db.session.listSessions())
      .filter(
        (row) =>
          !row.entry &&
          reports(harnessIdOf(row)) &&
          !current(row.process?.integration ?? undefined) &&
          !archived(row) &&
          (row.process?.placedAt ?? null) !== null &&
          terminalOf(row).id !== "",
      )
      .map((row) => ({
        id: row.id,
        agent: row.agent,
        harnessId: harnessIdOf(row),
        integration: row.process?.integration ?? undefined,
        runtime: runtimeOf(row),
        pid: pidOf(row),
        harnessSessionId: row.process?.harnessSessionId ?? null,
        working: Effect.succeed<boolean | undefined>(executionStateOf(row) === "open"),
      }))

    const entries = (yield* db.session.entrySessions)
      .filter((entry) => reports(harnessIdOf(entry)) && !current(entry.process?.integration ?? undefined))
      .map((entry) => ({
        id: entry.id,
        agent: entry.agent,
        harnessId: harnessIdOf(entry),
        integration: entry.process?.integration ?? undefined,
        runtime: placedTerminal(entry)?.runtime,
        pid: pidOf(entry),
        harnessSessionId: entry.process?.harnessSessionId ?? null,
        working: entryRunning(entry).pipe(
          Effect.map((seen) => (seen === undefined ? undefined : stateOf(seen) === "working")),
        ),
      }))

    const listed: Array<Outdated> = []

    for (const candidate of [...sessions, ...entries]) {
      const working = yield* candidate.working

      if (working === undefined) continue
      listed.push({
        id: candidate.id,
        agent: candidate.agent,
        harness: candidate.harnessId,
        integration: candidate.integration?.version ?? null,
        working,
        blocked:
          blockedOf(
            harnesses.find(candidate.harnessId),
            yield* routed(candidate.runtime),
            candidate.pid,
            candidate.harnessSessionId,
          ) ?? null,
      })
    }

    return listed
  })

  const restartOwned = (id: string, working: boolean) =>
    restarting.own(
      id,
      Effect.gen(function* () {
        const entry = (yield* db.session.entrySessions).find((candidate) => candidate.id === id)

        return yield* entry === undefined ? restartAgent(id) : restartEntry(entry, working)
      }),
    )

  const restart = Effect.fn("Restart.restart")((ids: ReadonlyArray<string>, working: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(new Set(ids), (id) => restartOwned(id, working.includes(id)), {
        concurrency: RESTART_CONCURRENCY,
      })

      for (const o of outcomes) yield* o.ok ? Effect.logInfo(o.message) : Effect.logWarning(o.message)

      return outcomes
    }),
  )

  const runningTheCommand = (entry: SessionRow, command: number) => {
    const pid = pidOf(entry)

    return pid === undefined
      ? Effect.succeed(false)
      : processes.tree(pid).pipe(Effect.map((tree) => tree?.includes(command) === true))
  }

  const restartLater = Effect.fn("Restart.restartLater")((ids: ReadonlyArray<string>, after: number | undefined) =>
    Effect.gen(function* () {
      const working: Array<string> = []

      for (const entry of yield* db.session.entrySessions) {
        if (!ids.includes(entry.id)) continue

        if (
          stateOf((yield* entryRunning(entry)) ?? "unknown") === "working" ||
          (after !== undefined && (yield* runningTheCommand(entry, after)))
        )
          working.push(entry.id)
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
    Agents.node,
    Bus.node,
    Db.node,
    Harness.node,
    Harnesses.node,
    Placement.node,
    Processes.node,
    Reconcile.node,
    Runtimes.node,
    SessionLive.node,
    SessionLocks.node,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
