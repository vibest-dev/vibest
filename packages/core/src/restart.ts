import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
// The restart in place (`vibest update`, .agents/rules/update-restart.md 6 and 7): only the harness ends; its terminal's
// shell runs it again through the runtime's `run`, on the same session and conversation. Subagents first, then main
// agents, whose continue notice names the subagents restarted with them.
import { Duration, Effect, Exit, FileSystem, Option, Path, Schedule, type Scope } from "effect"

import type { CoordinatorRow, Db, SessionRow } from "./db.ts"
import type { HarnessAdapter, HarnessId } from "./harness.ts"
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

/** An agent `vibest update` finds on an old integration. `blocked`: why it cannot be restarted in place (null: it can). */
export interface Outdated {
  readonly id: string
  readonly agent: string
  readonly harness: HarnessId
  /** The integration version it last reported; null when it never reported one. */
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

/** How long a restarted harness has to exit and its terminal to start it again. */
export const RESTART_TIMEOUT = Duration.seconds(60)
/** How long a restart waits for the `vibest update` that asked for it to exit. */
export const AFTER_WAIT = Duration.seconds(10)
/** Subagents restarted at once by `vibest update`. */
export const RESTART_CONCURRENCY = 4
/**
 * The instruction an interrupted turn gets once its harness is back. It is the first line of a main agent's notice, the
 * line its delivery shows and the model acts on, so it fits LINE_MAX with no version in it (an agent that ran `vibest
 * update` itself must not run it again).
 */
export const CONTINUE =
  "vibest update is done and restarted this agent; do not run it again, continue the interrupted work."

/** A subagent's continue turn. */
export const continueText = (version: string) => `${CONTINUE} vibest is now ${version}.`

/** A main agent's continue notice: the instruction first, then the version and who was restarted. */
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

/** The agent's recorded integration is this vibestd's own. */
export const current = (integration: { readonly version: string; readonly protocol: number } | undefined) =>
  integration !== undefined && integration.version === VERSION && integration.protocol === PROTOCOL

/** Why an agent cannot be restarted in place; undefined when it can. */
export const blockedOf = (
  adapter: HarnessAdapter,
  h: Runtime | undefined,
  pid: number | undefined,
  harnessSessionId: string | null,
) =>
  adapter.ready !== "integration"
    ? "its harness has no integration that reports its pid and when it is ready; quit it and start it again yourself"
    : h?.run === undefined
      ? "its runtime cannot start a program in its terminal again; quit it and start it again yourself"
      : pid === undefined
        ? "its harness never reported its pid; quit it and start it again yourself"
        : harnessSessionId === null
          ? "its conversation id is not known, so a restart would start a new conversation"
          : undefined

const TICK = Schedule.spaced("500 millis")

/** What the pid, ready report and integration of an agent being restarted read now. */
type LiveNow = Effect.Effect<
  | {
      readonly pid?: number | undefined
      readonly ready?: number | undefined
      readonly integration?: Parameters<typeof current>[0]
    }
  | undefined
>

/** One agent to restart in place: what differs between a subagent and a main agent. */
interface Target {
  readonly id: string
  readonly projectId: string
  /** How messages name it: its id, and "(main agent)" for one. */
  readonly label: string
  readonly adapter: HarnessAdapter
  readonly h: Runtime | undefined
  readonly terminal: Terminal
  readonly pid: number | undefined
  readonly harnessSessionId: string | null
  readonly interrupted: boolean
  /** What its terminal's shell runs again. */
  readonly argv: Effect.Effect<ReadonlyArray<string>, unknown>
  readonly liveNow: LiveNow
  /** The session's lock (a subagent), or none (a main agent). */
  readonly locked: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** Appended to a failure: where to look. */
  readonly hint: string
  /** Under `locked`, once it is back: the continue for an interrupted turn, and the outcome. */
  readonly onBack: (h: Runtime) => Effect.Effect<Restarted, unknown>
}

export const sessionRestart = (deps: {
  readonly db: Db["Service"]
  readonly runtimes: Runtimes["Service"]
  readonly harnesses: { readonly get: (id: HarnessId) => HarnessAdapter }
  readonly processes: Processes["Service"]
  readonly restarting: Restarting["Service"]
  readonly inbox: Inbox["Service"]
  /** vibestd's own scope: `restartLater` runs there. */
  readonly scope: Scope.Scope
  /** The session's lock, as every session change takes it. */
  readonly locked: (id: string) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** The harness argv that starts the session (resume: on its conversation). */
  readonly launchArgv: (session: SessionRow, resume: boolean) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, unknown>
  /** vibestd's platform services, for a harness's own `canResume`. */
  readonly withPlatform: <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => Effect.Effect<A, E>
  /** Wait until the harness takes input, as any start does. */
  readonly awaitReady: (
    h: Runtime,
    terminal: Terminal,
    adapter: HarnessAdapter,
    id: string,
  ) => Effect.Effect<unknown, unknown>
  /** A turn typed into the session, as `vibest send` delivers; why it was missed, or undefined. */
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

  /**
   * Wait for the harness `run` started to report its pid (the restart cleared the old one) and, on this vibest's
   * integration, that it is ready; false when RESTART_TIMEOUT passes. The caller then waits as any start does.
   */
  const startedAgain = (liveNow: LiveNow) =>
    liveNow.pipe(
      Effect.map((live) => live?.pid !== undefined && live.ready !== undefined && current(live.integration)),
      Effect.repeat({ until: (again) => again, schedule: TICK }),
      Effect.timeoutOrElse({ duration: RESTART_TIMEOUT, orElse: () => Effect.succeed(false) }),
    )

  /** Mark, SIGTERM to its harness pid only, `run` in the same terminal, then wait for it; written once for both kinds. */
  const inPlace = (t: Target): Effect.Effect<Restarted> => {
    const { id, projectId, label } = t
    const failed = (why: string): Restarted => ({ id, projectId, ok: false, message: `${label} ${why}` })
    return Effect.gen(function* () {
      const blocked = blockedOf(t.adapter, t.h, t.pid, t.harnessSessionId)
      if (blocked !== undefined) return failed(`not restarted: ${blocked}`)
      const h = t.h!
      const pid = t.pid!
      const argv = yield* t.argv
      const signalled = yield* t.locked(
        Effect.gen(function* () {
          yield* deps.restarting.mark(id)
          const sent = yield* processes.terminate(pid)
          // A refused SIGTERM writes nothing. Otherwise the old harness's process ends (its pid and ready report with
          // it) and the next one starts in the same terminal on the same conversation.
          if (sent === "denied") yield* deps.restarting.clear(id)
          else yield* db.restartProcess(id)
          return sent
        }),
      )
      if (signalled === "denied") return failed(`not restarted: SIGTERM to ${pid} was refused`)
      // Only the harness ended: its terminal's shell takes it again, on the same conversation.
      const ran = yield* h.run!(t.terminal, argv).pipe(Effect.exit)
      const back =
        Exit.isSuccess(ran) &&
        (yield* startedAgain(t.liveNow)) &&
        Option.isSome(yield* deps.awaitReady(h, t.terminal, t.adapter, id).pipe(Effect.option))
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
      // However it ends (back, failed, or vibestd stopping part way): the mark must not keep the session from its checks.
      Effect.ensuring(deps.restarting.clear(id)),
      Effect.catchCause((cause) => Effect.succeed(failed(`not restarted: ${errorMessage(cause)}`))),
    )
  }

  /** The harness argv that reopens a subagent's own conversation when the harness can (a first start has none yet). */
  const againArgv = (session: SessionRow) =>
    Effect.gen(function* () {
      const adapter = harnesses.get(session.harnessId)
      const resume =
        session.harnessSessionId !== null &&
        (adapter.canResume === undefined ||
          (yield* adapter.canResume(yield* deps.worktreeOf(session), session.harnessSessionId)))
      return yield* deps.launchArgv(session, resume)
    }).pipe(deps.withPlatform)

  const restartAgent = (id: string): Effect.Effect<Restarted> =>
    Effect.gen(function* () {
      const session = yield* db.getSession(id)
      if (session === undefined)
        return { id, projectId: "", ok: false, message: `${id} not restarted: no such session` }
      // An open round stays open across the restart: the continue is another turn of it, and it reports once.
      const interrupted = session.turnState === "open"
      return yield* inPlace({
        id,
        projectId: session.projectId,
        label: id,
        adapter: harnesses.get(session.harnessId),
        h: yield* routed(session.runtime),
        terminal: session.address,
        pid: session.metadata.pid,
        harnessSessionId: session.harnessSessionId,
        interrupted,
        argv: againArgv(session),
        liveNow: db.getSession(id).pipe(Effect.map((row) => row?.metadata)),
        locked: deps.locked(id),
        hint: `; ${peekHint(id)}`,
        onBack: (h) =>
          Effect.gen(function* () {
            const projectId = session.projectId
            if (!interrupted) return { id, projectId, ok: true, message: `${id} restarted` }
            // The same delivery a `vibest send` gets: a turn of the open round, typed in once the harness takes it.
            const missed = yield* deps.prompt(
              h,
              (yield* db.getSession(id)) ?? session,
              session.address,
              continueText(VERSION),
            )
            return missed === undefined
              ? { id, projectId, ok: true, message: `${id} restarted; its interrupted turn continues` }
              : { id, projectId, ok: false, message: `${id} restarted, but ${missed}` }
          }),
      })
    })

  /**
   * The main agent last: when it was working, its inbox gets the continue notice once its new harness reports ready,
   * delivered as any row is for its harness (subscribe, the HTTP poll, or typed in). `before`: the subagents of this
   * restart, which the notice names. `wasWorking`: it was working when the restart was asked (a `vibest update` it
   * ran itself, whose turn may end before the restart comes).
   */
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
        adapter: harnesses.get(main.harnessId),
        h,
        terminal: main.address,
        pid: main.pid,
        harnessSessionId: main.harnessSessionId,
        interrupted,
        // Its own shell, at the project's root, starts it again on its conversation. `vibest` is the bare name, so the
        // version on the person's PATH; an older one is refused with a mismatch.
        argv: Effect.succeed(["vibest", "integration", "start", id]),
        liveNow: Effect.gen(function* () {
          const row = yield* db.coordinatorOf(projectId)
          return row?.id === id ? { ...row, ready: yield* db.readyAt(id) } : undefined
        }),
        locked: (effect) => effect,
        hint: "",
        onBack: () =>
          Effect.gen(function* () {
            const restarted: Restarted = {
              id,
              projectId,
              ok: true,
              message: `${label} restarted${interrupted ? "; its interrupted turn continues" : ""}`,
            }
            if (interrupted)
              yield* inbox.enqueue({
                sessionId: id,
                kind: "notice",
                message: continueNotice(VERSION, [...before.filter((r) => r.projectId === projectId), restarted]),
                details: {},
              })
            return restarted
          }),
      })
    })

  /** A main agent's terminal still runs it: the runtime sees an agent there. */
  const mainRunning = (main: CoordinatorRow) =>
    Effect.gen(function* () {
      if (!main.runtime || !main.address || main.address.id === "") return undefined
      const h = yield* routed(main.runtime)
      if (h === undefined) return undefined
      const seen = yield* agentState(h, main.address).pipe(Effect.option)
      return Option.isNone(seen) || seen.value === "absent" ? undefined : seen.value
    })

  /** Only a harness whose integration reports its version can be on an old one; any other is never listed. */
  const reports = (harness: HarnessId) => harnesses.get(harness).ready === "integration"

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
          blockedOf(harnesses.get(main.harnessId), yield* routed(main.runtime), main.pid, main.harnessSessionId) ??
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
        working: row.turnState === "open",
        blocked:
          blockedOf(harnesses.get(row.harnessId), yield* routed(row.runtime), row.metadata.pid, row.harnessSessionId) ??
          null,
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

  const restartLater = (ids: ReadonlyArray<string>, after: number | undefined) =>
    Effect.gen(function* () {
      // Read before the wait: a main agent that ran `vibest update` itself is working now, maybe not once it exits.
      const working: Array<string> = []
      for (const main of yield* db.coordinators)
        if (ids.includes(main.id) && stateOf((yield* mainRunning(main)) ?? "unknown") === "working")
          working.push(main.id)
      const waited =
        after === undefined
          ? Effect.void
          : processes
              .liveness(after)
              .pipe(Effect.repeat({ until: (l) => l !== "alive", schedule: TICK }), Effect.timeoutOption(AFTER_WAIT))
      yield* waited.pipe(Effect.andThen(restart(ids, working)), Effect.forkIn(deps.scope))
    }).pipe(Effect.asVoid)

  return { outdated, restart, restartLater }
}
