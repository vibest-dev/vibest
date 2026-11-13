import { PROTOCOL } from "@vibest/schema/version"
import { Context, Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Schedule } from "effect"

import { Agents } from "../agents.ts"
import { App } from "../app.ts"
import { awaitEvent, Bus, type BusEvent } from "../bus.ts"
import {
  archived,
  Db,
  executionStateOf,
  harnessIdOf,
  pidOf,
  placedTerminal,
  reportedOf,
  runtimeOf,
  type SessionRow,
  terminalOf,
} from "../db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as PlatformNode from "../effect/platform.ts"
import { Harness, type HarnessId, Harnesses } from "../harness.ts"
import type { HarnessDefinition } from "../host.ts"
import { entryCommand, restartArgv } from "../launch.ts"
import { Layout, VibestCommand } from "../paths.ts"
import { errorMessage } from "../plugins.ts"
import { Processes } from "../processes.ts"
import { noticeEnvelope } from "../replies.ts"
import { agentState, type AgentSeen, peekHint, type Runtime, Runtimes, stateOf, type Terminal } from "../runtimes.ts"
import { Executions } from "./executions.ts"
import { SessionLive, type Restarted } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement, runtimeEnv } from "./placement.ts"
import { Reconcile } from "./reconcile.ts"

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

const make = Effect.gen(function* () {
  const db = yield* Db
  const runtimes = yield* Runtimes
  const harness = yield* Harness
  const harnesses = yield* Harnesses
  const agents = yield* Agents
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processes = yield* Processes
  const { restarting } = yield* SessionLive
  const bus = yield* Bus
  const scope = yield* Effect.scope
  const { locked } = yield* SessionLocks
  const version = (yield* App).version
  const { awaitReady, prompt } = yield* Executions
  const checkLater = (id: string) => Effect.forkIn(reconcile.check(id), scope).pipe(Effect.asVoid)
  const { launchArgv } = yield* Placement
  const reconcile = yield* Reconcile
  const vibestCommand = yield* VibestCommand

  const entryArgv = (entry: SessionRow) =>
    Effect.gen(function* () {
      yield* db.patchLive(entry.id, { ready: null })
      const root = (yield* db.projectDirectory(entry.projectId)) || (yield* db.sessionDirectory(entry.id)) || ""
      const savedId = entry.process?.conversation ?? null
      const place = placedTerminal(entry)
      const command = yield* entryCommand({
        harness: harnessIdOf(entry),
        agent: entry.agent,
        root,
        provider: entry.process?.provider ?? null,
        model: entry.process?.model ?? null,
        session: Effect.succeed({
          sessionId: entry.id,
          harnessSessionId: savedId !== null && (yield* db.canResumeConversation(entry.id, savedId)) ? savedId : null,
          projectId: entry.projectId,
          ...(place === undefined ? {} : { runtime: runtimeEnv(place.runtime, place.address) }),
        }),
      })
      return restartArgv(command)
    }).pipe(
      Effect.provideService(Agents, agents),
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
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
      ReadonlyArray<string>,
      Effect.Error<ReturnType<typeof entryArgv>> | Effect.Error<ReturnType<typeof launchArgv>>
    >
    readonly liveNow: LiveNow
    readonly hint: string
    readonly onBack: (h: Runtime) => Effect.Effect<Restarted, Effect.Error<ReturnType<typeof prompt>>>
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
    ).pipe(Effect.provideService(Bus, bus))
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
      const signalled = yield* locked(id)(
        Effect.gen(function* () {
          yield* restarting.mark(id)
          const sent = yield* processes.terminate(pid)
          if (sent === "denied") yield* restarting.clear(id)
          else yield* db.restartProcess(id)
          return sent
        }),
      )
      if (signalled === "denied") return failed(`not restarted: SIGTERM to ${pid} was refused`)
      const ran = yield* h.run!(t.terminal, argv).pipe(Effect.exit)
      const cameBack = yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startedAgain(id, t.liveNow).pipe(Effect.forkScoped)
          const ready = yield* awaitReady(h, t.terminal, adapter, id).pipe(Effect.option, Effect.forkScoped)
          return (yield* Fiber.join(started)) && Option.isSome(yield* Fiber.join(ready))
        }),
      )
      const back = Exit.isSuccess(ran) && cameBack
      return yield* locked(id)(
        Effect.gen(function* () {
          yield* restarting.clear(id)
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
      Effect.ensuring(restarting.clear(id).pipe(Effect.andThen(checkLater(id)))),
      Effect.catchCause((cause) => Effect.succeed(failed(`not restarted: ${errorMessage(cause)}`))),
    )
  }

  const againArgv = (session: SessionRow) => launchArgv(session, (session.process?.conversation ?? null) !== null)

  const restartAgent = (id: string): Effect.Effect<Restarted> =>
    Effect.gen(function* () {
      const session = yield* db.getSession(id)
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
        harnessSessionId: session.process?.conversation ?? null,
        argv: againArgv(session),
        liveNow: db.getSession(id).pipe(Effect.map(reportedOf)),
        hint: `; ${peekHint(id)}`,
        onBack: (h) =>
          Effect.gen(function* () {
            const projectId = session.projectId
            if (!interrupted) return { id, projectId, ok: true, message: `${id} restarted` }
            const missed = yield* prompt(
              h,
              (yield* db.getSession(id)) ?? session,
              terminalOf(session),
              noticeEnvelope(continueText(version)),
            )
            return missed === undefined
              ? { id, projectId, ok: true, message: `${id} restarted; its interrupted execution continues` }
              : { id, projectId, ok: false, message: `${id} restarted, but ${missed}` }
          }),
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
        harnessSessionId: entry.process?.conversation ?? null,
        argv: entryArgv(entry),
        liveNow: Effect.gen(function* () {
          const row = yield* db.entryOf(projectId)
          return row?.id === id ? reportedOf(row) : undefined
        }),
        hint: "",
        onBack: (h) =>
          Effect.gen(function* () {
            if (!interrupted) return { id, projectId, ok: true, message: `${label} restarted` } satisfies Restarted
            const row = yield* db.getSession(id)
            const missed =
              row === undefined
                ? "it is gone"
                : yield* prompt(h, row, place.address, noticeEnvelope(continueText(version)))
            return missed === undefined
              ? { id, projectId, ok: true, message: `${label} restarted; its interrupted execution continues` }
              : { id, projectId, ok: false, message: `${label} restarted, but ${missed}` }
          }),
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
    const sessions = (yield* db.listSessions())
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
        harnessSessionId: row.process?.conversation ?? null,
        working: Effect.succeed<boolean | undefined>(executionStateOf(row) === "open"),
      }))
    const entries = (yield* db.entrySessions)
      .filter((entry) => reports(harnessIdOf(entry)) && !current(entry.process?.integration ?? undefined))
      .map((entry) => ({
        id: entry.id,
        agent: entry.agent,
        harnessId: harnessIdOf(entry),
        integration: entry.process?.integration ?? undefined,
        runtime: placedTerminal(entry)?.runtime,
        pid: pidOf(entry),
        harnessSessionId: entry.process?.conversation ?? null,
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
        const entry = (yield* db.entrySessions).find((candidate) => candidate.id === id)
        return yield* entry === undefined ? restartAgent(id) : restartEntry(entry, working)
      }),
    )

  const restart = (ids: ReadonlyArray<string>, working: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(new Set(ids), (id) => restartOwned(id, working.includes(id)), {
        concurrency: RESTART_CONCURRENCY,
      })
      for (const o of outcomes) yield* o.ok ? Effect.logInfo(o.message) : Effect.logWarning(o.message)
      return outcomes
    })

  const runningTheCommand = (entry: SessionRow, command: number) => {
    const pid = pidOf(entry)
    return pid === undefined
      ? Effect.succeed(false)
      : processes.tree(pid).pipe(Effect.map((tree) => tree?.includes(command) === true))
  }

  const restartLater = (ids: ReadonlyArray<string>, after: number | undefined) =>
    Effect.gen(function* () {
      const working: Array<string> = []
      for (const entry of yield* db.entrySessions) {
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
    }).pipe(Effect.asVoid)

  return { outdated, restart, restartLater }
})

export class Restart extends Context.Service<Restart, Effect.Success<typeof make>>()("vibest/Restart") {
  static readonly make = make

  static readonly layer = Layer.effect(Restart, make)

  static readonly node = LayerNode.make({
    service: Restart,
    layer: Restart.layer,
    deps: [
      App.node,
      Agents.node,
      Bus.node,
      Db.node,
      Executions.node,
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
}
