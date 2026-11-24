import { entryLabel } from "@vibest/schema/id"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import {
  addPluginHint,
  describeSpawn,
  LaunchFailed,
  NoRuntime,
  NoSuchSession,
  type RuntimeMachine,
  type RuntimeAddress,
  HarnessUnavailable,
  type HarnessId,
} from "@vibest/schema/session"
import { Context, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect"

import { definitionLaunch } from "../agent-launch.ts"
import { Agents, unknownAgent } from "../agents.ts"
import { Bus } from "../bus.ts"
import { archived, encodeAddress, harnessIdOf, pidOf, placedTerminal, type SessionRow } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { KeyedMutex } from "../effect/keyed-mutex.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Harness, startableOptions } from "../harness.ts"
import { Harnesses } from "../harnesses.ts"
import { entryIdle } from "../inbox.ts"
import * as Launch from "../launch.ts"
import { Plugins } from "../plugin.ts"
import { Processes } from "../processes.ts"
import { machinesListing, Runtimes, type Terminal } from "../runtimes.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks, terminalLock } from "./locks.ts"
import { runtimeEnv } from "./placement.ts"
import { HARNESS_EXIT_WAIT, stopAgent } from "./release.ts"

export * as EntrySession from "./entry.ts"

export const PRESENT_TIMEOUT = Duration.seconds(5)

export class SessionRunning extends Schema.TaggedError<SessionRunning>()("SessionRunning", {
  sessionId: Schema.String,
  harness: Schema.String,
  place: Schema.String,
}) {}

const placeOf = (runtime: { readonly id: string; readonly name?: string }, address: RuntimeAddress) => {
  const name = runtime.name ?? runtime.id

  return address.id !== "" ? `${name} ${address.id}` : `${name} (not placed)`
}

export const sameTerminal = (current: SessionRow | undefined, runtime: string, address: string) => {
  const place = current === undefined ? undefined : placedTerminal(current)

  return place !== undefined && place.runtime === runtime && encodeAddress(place.address) === address
}

const ROOT_FIRST_INPUT =
  "The user has opened this conversation and has not given a task yet. Wait for the user's instructions."

export interface RootAgent {
  readonly id: string
  readonly named: boolean
}

const firstStart = new LaunchFailed({
  message: "no harness to inherit: pass --harness, for example `vibest --harness claude`",
})

const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const bus = yield* Bus.Service
  const runtimes = yield* Runtimes.Service
  const restarting = (yield* SessionLive.Service).restarting
  const plugins = yield* Plugins.Service
  const agents = yield* Agents.Service
  const harness = yield* Harness.Service
  const harnesses = yield* Harnesses.Service
  const processes = yield* Processes.Service
  const layout = yield* Layout
  const vibestCommand = yield* VibestCommand
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projectLocked = yield* KeyedMutex.make<string>()
  const locks = yield* SessionLocks.Service

  const withHarness = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Harness.Service, harness),
      Effect.provideService(Harnesses.Service, harnesses),
      Effect.provideService(Layout, layout),
      Effect.provideService(VibestCommand, vibestCommand),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )

  const harnessIds = () => harnesses.all.map((definition) => definition.id)

  const firstInputOf = (harness: HarnessId) =>
    harnesses.find(harness)?.systemPromptInPrompt === true ? ROOT_FIRST_INPUT : undefined

  const targetSession = (projectId: string, sessionId: string | undefined, fresh: boolean) =>
    Effect.gen(function* () {
      if (fresh) return undefined

      if (sessionId === undefined) return yield* db.session.latestRoot(projectId)
      const row = yield* db.session.getSession(sessionId)

      if (row === undefined || row.projectId !== projectId)
        return yield* new NoSuchSession({ id: sessionId, message: `no session ${sessionId}` })

      if (archived(row)) return yield* new NoSuchSession({ id: sessionId, message: `${sessionId} was archived` })

      return row
    })

  const rootAgent = (current: { readonly agent: string } | undefined, fresh: boolean, requested: RootAgent) => {
    const isNew = current === undefined || fresh

    if (!isNew && requested.named && requested.id !== current.agent)
      return Effect.fail(
        new LaunchFailed({
          message: `this session runs as ${current.agent}; add --new to start a new conversation as ${requested.id}`,
        }),
      )
    const id = isNew ? requested.id : current.agent
    const definition = agents.find(id)

    return definition === undefined ? Effect.fail(unknownAgent(id, agents)) : Effect.succeed({ id, definition, isNew })
  }

  type Chosen = Effect.Success<ReturnType<typeof rootAgent>>

  const decide = (input: {
    readonly root: string
    readonly agent: Chosen
    readonly current: SessionRow | undefined
    readonly harness: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly machine: string
    readonly runtime: string | undefined
  }) =>
    Effect.gen(function* () {
      const ownLaunch = input.agent.isNew ? definitionLaunch(input.agent.definition, input) : undefined

      return yield* plugins.start(
        {
          project: input.root,
          agent: input.agent.id,
          parentSessionId: undefined,
          prompt: "",
          harness:
            ownLaunch?.choice.harness ??
            input.harness ??
            (input.current === undefined ? undefined : harnessIdOf(input.current)),
          provider: ownLaunch?.choice.provider ?? input.provider,
          model: ownLaunch?.choice.model ?? input.model,
          harnesses: yield* withHarness(startableOptions),
          machine: { id: input.machine },
          runtime: input.runtime,
          parentRuntime: input.current === undefined ? undefined : placedTerminal(input.current)?.runtime,
          machines: yield* machinesListing(runtimes, harnessIds()).pipe(Effect.orElseSucceed(() => [])),
        },
        ownLaunch?.decidedBy,
      )
    })

  const runningOf = (session: SessionRow | undefined, terminal: string) =>
    Effect.gen(function* () {
      const place = session === undefined ? undefined : placedTerminal(session)

      if (session === undefined || place === undefined || place.address.id === terminal) return null
      const found = runtimes.find(place.runtime)

      if (!(yield* restarting.has(session.id))) {
        if (found === undefined) return null
        const presence = yield* entryIdle(found, place.address).pipe(Effect.option)

        if (Option.isNone(presence) || (presence.value !== "idle" && presence.value !== "busy")) return null
      }

      return {
        sessionId: session.id,
        harness: harnessIdOf(session),
        place: placeOf(found ?? { id: place.runtime }, place.address),
        runtime: place.runtime,
        address: encodeAddress(place.address),
      }
    })

  const running = Effect.fn("EntrySession.running")(function* (
    projectId: string,
    terminal: string,
    sessionId?: string,
  ) {
    const target = yield* targetSession(projectId, sessionId, false)

    return yield* runningOf(target, terminal)
  })

  const onlyRuntime = Effect.map(runtimes.all, (all) => (all.length === 1 ? all[0]?.id : undefined))

  const notRunning = (session: SessionRow | undefined, terminal: string) =>
    Effect.flatMap(runningOf(session, terminal), (found) =>
      found
        ? Effect.fail(new SessionRunning({ sessionId: found.sessionId, harness: found.harness, place: found.place }))
        : Effect.void,
    )

  const stopSession = (session: SessionRow, runtime: string, address: string) =>
    Effect.gen(function* () {
      const place = placedTerminal(session)

      if (place === undefined || !sameTerminal(session, runtime, address)) return { result: "moved" as const }

      if (yield* restarting.has(session.id))
        return {
          result: "unsupported" as const,
          reason: "vibest update is restarting it there; run vibest again once it is ready",
        }
      const h = yield* runtimes.route(runtime)

      return yield* stopAgent(h, place.address, {
        pid: pidOf(session),
        detach: db.session.detachSession(session.id, runtime, place.address),
        reattach: db.session.reattachSession(session.id),
        wait: HARNESS_EXIT_WAIT,
      }).pipe(Effect.provideService(Bus.Service, bus), Effect.provideService(Processes.Service, processes))
    })

  const launch = Effect.fn("EntrySession.launch")(function* (input: {
    readonly projectId: string
    readonly root: string
    readonly at: RuntimeMachine
    readonly sessionId: string | undefined
    readonly fresh: boolean
    readonly harness: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly focus: boolean
    readonly runtime: string | undefined
    readonly agent: RootAgent
  }) {
    const { projectId: id, root, at, fresh } = input
    const current = yield* targetSession(id, input.sessionId, fresh)
    const chosenAgent = yield* rootAgent(current, fresh, input.agent)
    const agent = chosenAgent.id

    const decision = yield* decide({
      root,
      agent: chosenAgent,
      current,
      harness: input.harness,
      provider: input.provider,
      model: input.model,
      machine: at.id,
      runtime: input.runtime,
    })

    if (decision.runtime === undefined) {
      const loaded = (yield* runtimes.all).map((h) => h.id)

      return yield* new NoRuntime({
        message: `no terminal runtime was chosen${loaded.length === 0 ? "" : `; loaded: ${loaded.join(", ")}`}`,
      })
    }

    if (decision.harness === undefined) return yield* firstStart

    if (harnesses.find(decision.harness) === undefined)
      return yield* new LaunchFailed({
        message: `unknown harness ${decision.harness}; loaded: ${harnessIds().join(", ")}; ${addPluginHint}`,
      })
    const chosen = decision.harness
    const rt = yield* runtimes.route(decision.runtime)
    yield* runtimes.online(rt)
    const run = rt.run

    if (run === undefined)
      return yield* new LaunchFailed({ message: "this runtime cannot type a command into the pane it opened" })
    let opened: Terminal | undefined
    let claimedId: string | undefined

    const closeLaunched = Effect.suspend(() =>
      opened === undefined
        ? Effect.void
        : rt
            .close(opened)
            .pipe(
              Effect.ignore,
              Effect.andThen(claimedId === undefined ? Effect.void : db.session.endProcess(claimedId, "launch_failed")),
            ),
    )

    return yield* Effect.gen(function* () {
      const command = yield* withHarness(
        Launch.entryCommand({
          harness: chosen,
          agent,
          root,
          provider: decision.provider ?? null,
          model: decision.model ?? null,
          session: projectLocked.withLock(id)(
            Effect.gen(function* () {
              const existing = yield* targetSession(id, input.sessionId, fresh)

              if (existing !== undefined) yield* notRunning(existing, "")

              const sessionId =
                existing === undefined ? yield* db.session.allocateSessionId().pipe(Effect.orDie) : existing.id

              const near =
                at.target === undefined || at.target === ""
                  ? yield* db.session.lastProjectTerminal(id, rt.id)
                  : undefined

              const pane = yield* Launch.openInParentWorkspace(rt, at.target, {
                root,
                label: existing?.name ?? entryLabel(root),
                home: layout.home,
                focus: input.focus,
                near,
              }).pipe(
                Effect.tap((pane) =>
                  Effect.sync(() => {
                    opened = pane
                  }),
                ),
                Effect.uninterruptible,
              )

              const claimed = yield* db.session
                .startRoot(
                  id,
                  chosen,
                  fresh,
                  { runtime: rt.id, address: pane },
                  {
                    provider: decision.provider,
                    model: decision.model,
                    routing: { decidedBy: decision.decidedBy, trace: decision.trace },
                    projectDirectory: root,
                    agent,
                    firstInput: firstInputOf(chosen),
                    ...(existing === undefined ? { sessionId } : { targetSessionId: existing.id }),
                  },
                )
                .pipe(
                  Effect.tap((claimed) =>
                    Effect.sync(() => {
                      claimedId = claimed.sessionId
                    }),
                  ),
                  Effect.uninterruptible,
                )

              return { ...claimed, runtime: runtimeEnv(rt.id, pane) }
            }),
          ),
        }),
      ).pipe(
        Effect.catchTag("HarnessUnavailable", (error) => Effect.fail(new LaunchFailed({ message: error.message }))),
        Effect.catchTag("SystemPromptDirUnsafe", (error) => Effect.fail(new LaunchFailed({ message: error.message }))),
      )

      if (opened === undefined || claimedId === undefined) return yield* Effect.die("launch opened no terminal")
      const pane = opened
      const sessionId = claimedId
      yield* run(pane, command).pipe(Effect.mapError((error) => new LaunchFailed({ message: error.message })))

      const routing =
        Object.keys(decision.decidedBy).length === 0
          ? undefined
          : describeSpawn({
              harness: chosen,
              provider: decision.provider,
              model: decision.model,
              decidedBy: decision.decidedBy,
            })

      return {
        sessionId,
        projectId: id,
        runtime: rt.id,
        terminal: pane.id,
        place: placeOf(rt, pane),
        attach: rt.attach?.(at.target, pane) ?? null,
        ...(routing !== undefined && { routing }),
      }
    }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeLaunched)))
  })

  const claim = Effect.fn("EntrySession.claim")(function* (input: {
    readonly projectId: string
    readonly directory: string
    readonly sessionId: string | undefined
    readonly harness: string | undefined
    readonly fresh: boolean
    readonly move: boolean
    readonly terminal: string
    readonly runtime: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly pid: number | undefined
    readonly agent: RootAgent
  }) {
    const { projectId, directory, terminal, fresh } = input
    const initial = yield* targetSession(projectId, input.sessionId, fresh)
    const chosenAgent = yield* rootAgent(initial, fresh, input.agent)

    const decision = yield* decide({
      root: directory,
      agent: chosenAgent,
      current: initial,
      harness: input.harness,
      provider: input.provider,
      model: input.model,
      machine: "local",
      runtime: input.runtime,
    })

    if (decision.harness === undefined) return yield* firstStart

    if (harnesses.find(decision.harness) === undefined)
      return yield* new HarnessUnavailable({
        harness: decision.harness,
        message: `unknown harness ${decision.harness}; loaded: ${harnessIds().join(", ")}; ${addPluginHint} (routed: ${describeSpawn({ ...decision, harness: decision.harness })})`,
      })

    const kind = decision.runtime ?? input.runtime ?? (yield* onlyRuntime)

    if (kind === undefined) return yield* new NoRuntime({ message: "the session's runtime is not named" })
    const rt = yield* runtimes.route(kind)
    yield* runtimes.online(rt)
    const chosenHarness = decision.harness
    const agent = chosenAgent.id

    const routing =
      Object.keys(decision.decidedBy).length === 0
        ? undefined
        : describeSpawn({
            harness: chosenHarness,
            provider: decision.provider,
            model: decision.model,
            decidedBy: decision.decidedBy,
          })

    return yield* projectLocked.withLock(projectId)(
      Effect.gen(function* () {
        const existing = yield* targetSession(projectId, input.sessionId, fresh)

        if (existing !== undefined) {
          const live = yield* runningOf(existing, terminal)

          if (live !== null) {
            if (!input.move)
              return yield* new SessionRunning({
                sessionId: live.sessionId,
                harness: live.harness,
                place: live.place,
              })
            const stopped = yield* stopSession(existing, live.runtime, live.address)

            if (stopped.result === "moved")
              return yield* new LaunchFailed({ message: "not starting: the session moved meanwhile; run vibest again" })

            if (stopped.result === "unsupported")
              return yield* new LaunchFailed({
                message: `not starting: the session (${live.harness}) runs in ${live.place} and cannot be moved from here: ${stopped.reason}. Exit it there first`,
              })

            if (stopped.result === "running")
              return yield* new LaunchFailed({
                message: `not starting: the session (${live.harness}) runs in ${live.place} and did not exit; nothing changed. Exit it there first`,
              })
          }
        }

        const address = { machine: "local", id: terminal }

        let claimed:
          | {
              readonly sessionId: string
              readonly harnessSessionId: string | null
              readonly projectId: string
              readonly process: number
              readonly runtime: string
            }
          | undefined

        const command = yield* withHarness(
          Launch.entryCommand({
            harness: chosenHarness,
            agent,
            root: directory,
            provider: decision.provider ?? null,
            model: decision.model ?? null,
            session: Effect.gen(function* () {
              const saved = yield* locks.withLock(terminalLock(rt.id, address))(
                db.session.startRoot(
                  projectId,
                  chosenHarness,
                  fresh,
                  { runtime: rt.id, address },
                  {
                    provider: decision.provider,
                    model: decision.model,
                    routing: { decidedBy: decision.decidedBy, trace: decision.trace },
                    pid: input.pid,
                    projectDirectory: directory,
                    agent,
                    firstInput: firstInputOf(chosenHarness),
                    ...(existing !== undefined && { targetSessionId: existing.id }),
                  },
                ),
              )

              claimed = { ...saved, runtime: runtimeEnv(rt.id, address) }

              return claimed
            }),
          }),
        ).pipe(
          Effect.catchTag("SystemPromptDirUnsafe", (error) =>
            Effect.fail(new LaunchFailed({ message: error.message })),
          ),
        )

        if (claimed === undefined) return yield* Effect.die("launch command returned without a session")

        if (rt.present !== undefined)
          yield* rt
            .present(address, { session: claimed.sessionId, projectId, title: entryLabel(directory) })
            .pipe(Effect.timeout(PRESENT_TIMEOUT), Effect.ignore)

        const typed = yield* Launch.launchLine(command).pipe(
          Effect.mapError((e) => new LaunchFailed({ message: e.message })),
        )

        let at = 0

        if (typed[0] === "env") {
          at = 1

          while (at < typed.length) {
            if (typed[at] === "-u") {
              at += 2
              continue
            }

            if (/^[A-Z_]+=/.test(typed[at]!)) {
              at += 1
              continue
            }

            break
          }
        }

        const [file, ...args] = typed.slice(at)

        return {
          sessionId: claimed.sessionId,
          harnessSessionId: claimed.harnessSessionId,
          projectId: claimed.projectId,
          runtime: claimed.runtime,
          ...(routing !== undefined && { routing }),
          command: { file: file!, args, env: command.env },
        }
      }),
    )
  })

  return { running, launch, claim }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/EntrySession") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Agents.node,
    Bus.node,
    Db.node,
    Harness.node,
    Harnesses.node,
    Plugins.node,
    Processes.node,
    Runtimes.node,
    SessionLive.node,
    SessionLocks.node,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
