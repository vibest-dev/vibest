import { Layout, VibestCommand } from "@vibest/schema/layout"
import {
  addPluginHint,
  describeSpawn,
  LaunchFailed,
  NoRuntime,
  type RuntimeMachine,
  type RuntimeAddress,
  HarnessUnavailable,
  type HarnessId,
} from "@vibest/schema/session"
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"

import { Agents, unknownAgent } from "../agents.ts"
import { Bus } from "../bus.ts"
import { AddressJson, encodeAddress, harnessIdOf, pidOf, placedTerminal, type SessionRow } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { KeyedMutex } from "../effect/keyed-mutex.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Harness, harnessOptions } from "../harness.ts"
import { Harnesses } from "../harnesses.ts"
import { entryIdle } from "../inbox.ts"
import * as Launch from "../launch.ts"
import { Plugins } from "../plugin.ts"
import { Processes } from "../processes.ts"
import { HARNESS_EXIT_WAIT, stopAgent } from "../remove.ts"
import { machinesListing, Runtimes, type Terminal } from "../runtimes.ts"
import { SessionLive } from "./live.ts"
import { runtimeEnv } from "./placement.ts"

export const PRESENT_TIMEOUT = Duration.seconds(5)

export class EntryRunning extends Schema.TaggedError<EntryRunning>()("EntryRunning", {
  harness: Schema.String,
  place: Schema.String,
}) {}

const placeOf = (runtime: { readonly id: string; readonly name?: string }, address: RuntimeAddress) => {
  const name = runtime.name ?? runtime.id
  return address.id !== "" ? `${name} ${address.id}` : `${name} (not placed)`
}

export const sameEntry = (current: SessionRow | undefined, runtime: string, address: string) => {
  const place = current === undefined ? undefined : placedTerminal(current)
  return place !== undefined && place.runtime === runtime && encodeAddress(place.address) === address
}

const ENTRY_FIRST_INPUT =
  "The user has opened this conversation and has not given a task yet. Wait for the user's instructions."

const firstStart = new LaunchFailed({
  message: "no harness to inherit: pass --harness, for example `vibest --harness claude`",
})

const make = Effect.gen(function* () {
  const db = yield* Db
  const bus = yield* Bus
  const runtimes = yield* Runtimes.Service
  const restarting = (yield* SessionLive).restarting
  const plugins = yield* Plugins
  const agents = yield* Agents.Service
  const harness = yield* Harness.Service
  const harnesses = yield* Harnesses.Service
  const processes = yield* Processes.Service
  const layout = yield* Layout
  const vibestCommand = yield* VibestCommand
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projectLocked = KeyedMutex.keyedLock<string>()

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
    harnesses.find(harness)?.systemPromptInPrompt === true ? ENTRY_FIRST_INPUT : undefined

  const known = (id: string) =>
    agents.find(id) === undefined ? Effect.fail(unknownAgent(id, agents.all)) : Effect.void

  const agentOf = (current: { readonly agent: string } | undefined, fresh: boolean, requested: string) =>
    current === undefined || fresh ? requested : current.agent

  const decide = (input: {
    readonly root: string
    readonly agent: string
    readonly current: SessionRow | undefined
    readonly harness: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly machine: string
    readonly runtime: string | undefined
  }) =>
    Effect.gen(function* () {
      return yield* plugins.start({
        project: input.root,
        agent: input.agent,
        parentSessionId: undefined,
        prompt: "",
        harness: input.harness ?? (input.current === undefined ? undefined : harnessIdOf(input.current)),
        provider: input.provider,
        model: input.model,
        harnesses: yield* withHarness(harnessOptions),
        attempts: [],
        machine: { id: input.machine },
        runtime: input.runtime,
        parentRuntime: input.current === undefined ? undefined : placedTerminal(input.current)?.runtime,
        machines: yield* machinesListing(runtimes, harnessIds()).pipe(Effect.orElseSucceed(() => [])),
      })
    })

  const running = Effect.fn("EntrySession.running")(function* (projectId: string, terminal: string) {
    const entry = yield* db.entryOf(projectId)
    const place = entry === undefined ? undefined : placedTerminal(entry)
    if (entry === undefined || place === undefined || place.address.id === terminal) return null
    const found = runtimes.find(place.runtime)
    if (!(yield* restarting.has(entry.id))) {
      if (found === undefined) return null
      const presence = yield* entryIdle(found, place.address).pipe(Effect.option)
      if (Option.isNone(presence) || (presence.value !== "idle" && presence.value !== "busy")) return null
    }
    return {
      harness: harnessIdOf(entry),
      place: placeOf(found ?? { id: place.runtime }, place.address),
      runtime: place.runtime,
      address: encodeAddress(place.address),
    }
  })

  const onlyRuntime = Effect.map(runtimes.all, (all) => (all.length === 1 ? all[0]?.id : undefined))

  const notRunning = (projectId: string, terminal: string) =>
    Effect.flatMap(running(projectId, terminal), (found) =>
      found ? Effect.fail(new EntryRunning({ harness: found.harness, place: found.place })) : Effect.void,
    )

  const launch = Effect.fn("EntrySession.launch")(function* (input: {
    readonly projectId: string
    readonly root: string
    readonly at: RuntimeMachine
    readonly argv: ReadonlyArray<string>
    readonly focus: boolean
    readonly runtime: string | undefined
    readonly agent: string
  }) {
    const { projectId: id, root, at, argv } = input
    const current = yield* db.entryOf(id)
    const fresh = argv.includes("--new")
    const agent = agentOf(current, fresh, input.agent)
    yield* known(agent)
    const decision = yield* decide({
      root,
      agent,
      current,
      harness: Launch.flagValue(argv, "--harness"),
      provider: Launch.flagValue(argv, "--provider"),
      model: Launch.flagValue(argv, "--model"),
      machine: at.id,
      runtime: input.runtime,
    })
    if (decision.runtime === undefined) {
      const loaded = (yield* runtimes.all).map((h) => h.id)
      return yield* new NoRuntime({
        message: `no terminal runtime was chosen for the entry session${loaded.length === 0 ? "" : `; loaded: ${loaded.join(", ")}`}`,
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
    const command = yield* withHarness(
      Launch.entryCommand({
        harness: chosen,
        agent,
        root,
        provider: decision.provider ?? null,
        model: decision.model ?? null,
        session: projectLocked.withLock(id)(
          Effect.gen(function* () {
            yield* notRunning(id, "")
            const existing = yield* db.entryOf(id)
            const sessionId =
              existing === undefined || fresh ? yield* db.allocateSessionId().pipe(Effect.orDie) : existing.id
            const pane = yield* Launch.openInParentWorkspace(rt, at.target, {
              root,
              label: "vibest",
              home: layout.home,
              focus: input.focus,
            })
            opened = pane
            const claimed = yield* db
              .startEntry(
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
                  ...(existing === undefined || fresh ? { sessionId } : {}),
                },
              )
              .pipe(Effect.tapError(() => rt.close(pane).pipe(Effect.ignore)))
            claimedId = claimed.sessionId
            return { ...claimed, runtime: runtimeEnv(rt.id, pane) }
          }),
        ),
      }),
    ).pipe(
      Effect.catchTag("HarnessUnavailable", (error) => Effect.fail(new LaunchFailed({ message: error.message }))),
      Effect.catchTag("SystemPromptDirUnsafe", (error) => Effect.fail(new LaunchFailed({ message: error.message }))),
      Effect.tapError(() =>
        opened === undefined
          ? Effect.void
          : rt
              .close(opened)
              .pipe(
                Effect.ignore,
                Effect.andThen(claimedId === undefined ? Effect.void : db.endProcess(claimedId, "launch_failed")),
              ),
      ),
    )
    if (opened === undefined) return yield* Effect.die("launch opened no terminal")
    const pane = opened
    yield* run(pane, Launch.restartArgv(command)).pipe(
      Effect.catch((error) =>
        rt
          .close(pane)
          .pipe(
            Effect.ignore,
            Effect.andThen(claimedId === undefined ? Effect.void : db.endProcess(claimedId, "launch_failed")),
            Effect.andThen(Effect.fail(new LaunchFailed({ message: error.message }))),
          ),
      ),
    )
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
      runtime: rt.id,
      terminal: pane.id,
      place: placeOf(rt, pane),
      attach: rt.attach?.(at.target) ?? null,
      ...(routing === undefined ? {} : { routing }),
    }
  })

  const start = Effect.fn("EntrySession.start")(function* (input: {
    readonly projectId: string
    readonly root: string
    readonly harness: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly runtime: string | undefined
    readonly agent: string
  }) {
    const current = yield* db.entryOf(input.projectId)
    const agent = agentOf(current, false, input.agent)
    yield* known(agent)
    const decision = yield* decide({ ...input, agent, current, machine: "local" })
    if (decision.harness === undefined) return yield* firstStart
    if (harnesses.find(decision.harness) === undefined)
      return yield* new HarnessUnavailable({
        harness: decision.harness,
        message: `unknown harness ${decision.harness}; loaded: ${harnessIds().join(", ")}; ${addPluginHint} (routed: ${describeSpawn({ ...decision, harness: decision.harness })})`,
      })
    if (decision.runtime === undefined)
      return yield* new NoRuntime({ message: "no terminal runtime was chosen for the entry session" })
    const rt = yield* runtimes.route(decision.runtime)
    yield* runtimes.online(rt)
    return { ...decision, harness: decision.harness, runtime: rt.id }
  })

  const claim = Effect.fn("EntrySession.claim")(function* (input: {
    readonly projectId: string
    readonly directory: string
    readonly harness: HarnessId
    readonly fresh: boolean
    readonly terminal: string
    readonly runtime: string | undefined
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly routing: unknown
    readonly pid: number | undefined
    readonly agent: string
  }) {
    const { projectId, directory, terminal } = input
    const agent = agentOf(yield* db.entryOf(projectId), input.fresh, input.agent)
    yield* known(agent)
    const kind = input.runtime ?? (yield* onlyRuntime)
    if (kind === undefined) return yield* new NoRuntime({ message: "the entry session's runtime is not named" })
    return yield* projectLocked.withLock(projectId)(
      Effect.gen(function* () {
        yield* notRunning(projectId, terminal)
        const address = { machine: "local", id: terminal }
        let claimed:
          | {
              readonly sessionId: string
              readonly harnessSessionId: string | null
              readonly projectId: string
              readonly runtime: string
            }
          | undefined
        const command = yield* withHarness(
          Launch.entryCommand({
            harness: input.harness,
            agent,
            root: directory,
            provider: input.provider ?? null,
            model: input.model ?? null,
            session: Effect.gen(function* () {
              const saved = yield* db.startEntry(
                projectId,
                input.harness,
                input.fresh,
                { runtime: kind, address },
                {
                  provider: input.provider,
                  model: input.model,
                  routing: input.routing,
                  pid: input.pid,
                  projectDirectory: directory,
                  agent,
                  firstInput: firstInputOf(input.harness),
                },
              )
              claimed = { ...saved, runtime: runtimeEnv(kind, address) }
              return claimed
            }),
          }),
        ).pipe(
          Effect.catchTag("SystemPromptDirUnsafe", (error) =>
            Effect.fail(new LaunchFailed({ message: error.message })),
          ),
        )
        if (claimed === undefined) return yield* Effect.die("entry command returned without a session")
        const rt = runtimes.find(kind)
        if (rt?.present !== undefined)
          yield* rt
            .present(address, { entrySession: claimed.sessionId, projectId })
            .pipe(Effect.timeout(PRESENT_TIMEOUT), Effect.ignore)
        return {
          sessionId: claimed.sessionId,
          harnessSessionId: claimed.harnessSessionId,
          projectId: claimed.projectId,
          runtime: claimed.runtime,
          command: { file: command.file, args: [...command.args], env: { ...command.env } },
        }
      }),
    )
  })

  const focus = Effect.fn("EntrySession.focus")(function* (projectId: string) {
    const found = yield* running(projectId, "")
    if (found === null) return null
    const runtime = runtimes.find(found.runtime)
    if (runtime?.focus === undefined) return { place: found.place, focused: false }
    const address = yield* Schema.decodeUnknownEffect(AddressJson)(found.address).pipe(Effect.orDie)
    const focused = yield* runtime.focus(address).pipe(Effect.exit)
    return { place: found.place, focused: focused._tag === "Success" }
  })

  const stop = Effect.fn("EntrySession.stop")(function* (projectId: string, runtime: string, address: string) {
    return yield* projectLocked.withLock(projectId)(
      Effect.gen(function* () {
        const entry = yield* db.entryOf(projectId)
        const place = entry === undefined ? undefined : placedTerminal(entry)
        if (entry === undefined || place === undefined || !sameEntry(entry, runtime, address))
          return { result: "moved" as const }
        if (yield* restarting.has(entry.id))
          return {
            result: "unsupported" as const,
            reason: "vibest update is restarting it there; run vibest again once it is ready",
          }
        const h = yield* runtimes.route(runtime)
        return yield* stopAgent(h, place.address, {
          pid: pidOf(entry),
          detach: db.detachEntry(projectId, runtime, place.address),
          reattach: db.reattachEntry(projectId, runtime, place.address),
          wait: HARNESS_EXIT_WAIT,
        }).pipe(Effect.provideService(Bus, bus), Effect.provideService(Processes.Service, processes))
      }),
    )
  })

  return { running, launch, start, claim, focus, stop }
})

export class EntrySession extends Context.Service<EntrySession, Effect.Success<typeof make>>()("vibest/EntrySession") {
  static readonly layer = Layer.effect(EntrySession, make)

  static readonly node = LayerNode.make({
    service: EntrySession,
    layer: EntrySession.layer,
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
      PlatformNode.fileSystem,
      PlatformNode.layout,
      PlatformNode.path,
    ],
  })
}
