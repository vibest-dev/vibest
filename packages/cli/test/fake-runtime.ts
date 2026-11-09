import { Runtime as R } from "@vibest/plugin"
import { Context, Deferred, Effect, HashMap, Layer, Option, PubSub, Ref, Stream } from "effect"

type Runtime = R.Runtime
type Terminal = R.Terminal
type RuntimeError = R.RuntimeError
type RuntimeEvent = R.RuntimeEvent
type AgentState = R.AgentState

export const KIND = "herdr"

export interface FakeAgent {
  readonly vibestSession?: string
  readonly session?: string
  readonly status: AgentState
  readonly seq: number
  readonly alive: boolean
  readonly registerPrompt?: boolean
}

export interface FakeRuntimeOptions {
  readonly promptsIgnored?: boolean
  readonly startError?: string
  readonly interruptIgnored?: boolean
  readonly statusEvents?: boolean
  readonly noRun?: boolean
  readonly offline?: string
  readonly noFocus?: boolean
}

export interface RuntimeCalls {
  readonly open: {
    readonly project: string
    readonly cwd: string
    readonly argv: ReadonlyArray<string>
    readonly env: Record<string, string>
    readonly label: string
    readonly near: string | undefined
    readonly split: boolean | undefined
    readonly focus: boolean | undefined
    readonly target?: string
  }
  readonly send: { readonly terminal: string; readonly text?: string; readonly keys?: ReadonlyArray<string> }
  readonly read: { readonly terminal: string; readonly lines: number }
  readonly process: { readonly terminal: string }
  readonly state: { readonly terminal: string }
  readonly session: { readonly terminal: string }
  readonly close: { readonly terminal: string }
  readonly run: { readonly terminal: string; readonly argv: ReadonlyArray<string> }
  readonly present: { readonly terminal: string; readonly info: Readonly<Record<string, string>> }
  readonly see: { readonly terminal: string; readonly turn: number }
  readonly focus: { readonly terminal: string }
}

type Entry = { [M in keyof RuntimeCalls]: { readonly method: M; readonly params: RuntimeCalls[M] } }[keyof RuntimeCalls]
type Workspace = { readonly path: string; readonly root: string; readonly open: boolean; readonly standalone?: boolean }

export interface WorkspaceState {
  readonly workspaceId: string
  readonly path: string
  readonly root: string
  readonly open: boolean
  readonly standalone: boolean
}

export type HoldMethod = keyof RuntimeCalls

type Hold = {
  readonly target: string | undefined
  readonly raw: string | undefined
  skip: number
  readonly reached: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<string | undefined>
}

export class FakeRuntime extends Context.Service<
  FakeRuntime,
  {
    readonly runtime: Runtime
    readonly callsTo: <M extends keyof RuntimeCalls>(method: M) => Effect.Effect<ReadonlyArray<RuntimeCalls[M]>>
    readonly callCount: Effect.Effect<number>
    readonly terminalOf: (session: string) => Effect.Effect<Terminal | undefined>
    readonly agent: (
      target: string,
    ) => Effect.Effect<{ readonly terminal: string; readonly agent: FakeAgent } | undefined>
    readonly updateAgent: (target: string, f: (agent: FakeAgent) => FakeAgent) => Effect.Effect<void>
    readonly endTurn: (target: string) => Effect.Effect<void>
    readonly finishTurn: (terminal: string) => Effect.Effect<void>
    readonly addWorkspace: (id: string, root: string, path?: string) => Effect.Effect<void>
    readonly addPane: (paneId: string, workspaceId: string, cwd: string) => Effect.Effect<void>
    readonly seedAgent: (terminal: string) => Effect.Effect<void>
    readonly panes: Effect.Effect<HashMap.HashMap<string, { readonly workspaceId: string; readonly cwd: string }>>
    readonly workspaceState: Effect.Effect<ReadonlyArray<WorkspaceState>>
    readonly hold: (
      method: HoldMethod,
      target?: string,
      skip?: number,
    ) => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: (code?: string) => Effect.Effect<void>
    }>
    readonly reachable: Ref.Ref<boolean>
    readonly onStarted: Ref.Ref<(session: string) => Effect.Effect<void>>
    readonly skipPromptUpdates: Ref.Ref<number>
    readonly events: PubSub.PubSub<RuntimeEvent>
  }
>()("test/FakeRuntime") {
  static readonly make = (options: FakeRuntimeOptions) =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<Entry>>([])
      const callCount = yield* Ref.make(0)
      const agents = yield* Ref.make(HashMap.empty<string, FakeAgent>())
      const workspaces = yield* Ref.make(HashMap.empty<string, Workspace>())
      const panes = yield* Ref.make(HashMap.empty<string, { readonly workspaceId: string; readonly cwd: string }>())
      const holds = yield* Ref.make(HashMap.empty<HoldMethod, Hold>())
      const events = yield* PubSub.unbounded<RuntimeEvent>()
      const onStarted = yield* Ref.make<(session: string) => Effect.Effect<void>>(() => Effect.void)
      const marks = yield* Ref.make(HashMap.empty<string, R.Seen>())
      const markOf = (terminal: string) =>
        Effect.map(Ref.get(marks), (map) =>
          Option.getOrElse(HashMap.get(map, terminal), (): R.Seen => ({ turn: 0, seen: 0 })),
        )
      const mark = (terminal: string, f: (now: R.Seen) => R.Seen) =>
        markOf(terminal).pipe(
          Effect.flatMap((now) => Ref.update(marks, (map) => HashMap.set(map, terminal, f(now)))),
          Effect.andThen(PubSub.publish(events, { type: "seen", terminal: { machine: "local", id: terminal } })),
          Effect.asVoid,
        )
      let counter = 0
      const next = () => Effect.sync(() => ++counter)

      const fail = (
        method: string,
        code: "not_found" | "busy" | "unreachable" | "incompatible" | "failed",
        message: string = code,
      ) => Effect.fail(new R.RuntimeError({ code, message: `${method}: ${message}` }))

      const resolve = (target: string) =>
        Ref.get(agents).pipe(
          Effect.map(
            (map) => HashMap.toEntries(map).find(([id, agent]) => id === target || agent.vibestSession === target)?.[0],
          ),
        )

      const updateAgent = (target: string, f: (agent: FakeAgent) => FakeAgent) =>
        resolve(target).pipe(
          Effect.flatMap((id) =>
            id === undefined
              ? Effect.void
              : Effect.gen(function* () {
                  yield* Ref.update(agents, (map) => HashMap.modify(map, id, f))
                  if (options.statusEvents) {
                    const after = Option.getOrThrow(HashMap.get(yield* Ref.get(agents), id))
                    yield* PubSub.publish(events, {
                      type: "state",
                      terminal: { machine: "local", id },
                      state: after.status,
                    })
                  }
                }),
          ),
        )

      const endTurn = (target: string) =>
        updateAgent(target, (agent) => ({ ...agent, status: "idle", seq: agent.seq + 1 }))

      const awaitHold = (method: HoldMethod, target: string | undefined) =>
        Effect.gen(function* () {
          const follows = Option.flatMap(HashMap.get(yield* Ref.get(holds), method), (hold) =>
            hold.raw === undefined ? Option.none<string>() : Option.some(hold.raw),
          )
          const moving = Option.isSome(follows) ? yield* resolve(follows.value) : undefined
          const found = Ref.modify(holds, (map) => {
            const hit = HashMap.get(map, method).pipe(
              Option.filter(
                (hold) =>
                  hold.target === undefined ||
                  hold.target === target ||
                  hold.raw === target ||
                  (moving !== undefined && target === moving),
              ),
            )
            if (Option.isSome(hit) && hit.value.skip > 0)
              return [
                Option.none<Hold>(),
                HashMap.set(map, method, { ...hit.value, skip: hit.value.skip - 1 }),
              ] as const
            return [hit, Option.isSome(hit) ? HashMap.remove(map, method) : map] as const
          })
          return yield* found
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (hold) =>
                Deferred.succeed(hold.reached, undefined).pipe(
                  Effect.andThen(Deferred.await(hold.release)),
                  Effect.flatMap((code) => {
                    const codes = ["not_found", "busy", "unreachable", "incompatible", "failed"] as const
                    return code === undefined
                      ? Effect.void
                      : codes.includes(code as never)
                        ? fail(method, code as "not_found" | "busy" | "unreachable" | "incompatible" | "failed")
                        : Effect.fail(new R.RuntimeError({ code: "failed", message: code }))
                  }),
                  Effect.asVoid,
                ),
            }),
          ),
        )

      const call = <M extends keyof RuntimeCalls, A>(
        method: M,
        params: RuntimeCalls[M],
        target: string | undefined,
        body: Effect.Effect<A, RuntimeError>,
      ) =>
        Ref.update(callCount, (n) => n + 1).pipe(
          Effect.andThen(Ref.update(log, (entries) => [...entries, { method, params } as Entry])),
          Effect.andThen(Effect.flatMap(Ref.get(reachable), (up) => (up ? Effect.void : fail(method, "unreachable")))),
          Effect.andThen(awaitHold(method, target)),
          Effect.andThen(body),
        )

      const reachable = yield* Ref.make(true)
      const skipPromptUpdates = yield* Ref.make(0)

      const addPane = (paneId: string, workspaceId: string, cwd: string) =>
        Effect.gen(function* () {
          yield* Ref.update(panes, (map) => HashMap.set(map, paneId, { workspaceId, cwd }))
          yield* Ref.update(agents, (map) => HashMap.remove(map, paneId))
        })

      const kill = (paneIds: ReadonlyArray<string>) =>
        Ref.update(agents, (map) => {
          let out = map
          for (const [id, agent] of HashMap.toEntries(map))
            if (paneIds.includes(id)) out = HashMap.set(out, id, { ...agent, alive: false })
          return out
        })

      const workspaceAt = (root: string) =>
        Effect.gen(function* () {
          const grouped = Option.map(
            HashMap.findFirst(yield* Ref.get(workspaces), (workspace) => workspace.open && workspace.path === root),
            ([id]) => id,
          )
          if (Option.isSome(grouped)) return grouped.value
          const at = HashMap.toEntries(yield* Ref.get(panes)).find(([, pane]) => pane.cwd === root)
          return at === undefined ? undefined : at[1].workspaceId
        })

      const shutWorkspace = (id: string) =>
        Effect.gen(function* () {
          const workspace = HashMap.get(yield* Ref.get(workspaces), id)
          if (Option.isSome(workspace)) {
            const closed: Workspace = { ...workspace.value, open: false }
            yield* Ref.update(workspaces, (map) => HashMap.set(map, id, closed))
          }
          const inside = HashMap.toEntries(yield* Ref.get(panes))
            .filter(([, pane]) => pane.workspaceId === id)
            .map(([paneId]) => paneId)
          yield* Ref.update(panes, (map) => inside.reduce((acc, paneId) => HashMap.remove(acc, paneId), map))
          return inside
        })

      const agentOf = (method: keyof RuntimeCalls, terminal: Terminal) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(agents)
          const agent = yield* Option.match(HashMap.get(map, terminal.id), {
            onNone: () => fail(method, "not_found"),
            onSome: Effect.succeed,
          })
          if (!HashMap.has(yield* Ref.get(panes), terminal.id)) return yield* fail(method, "not_found")
          if (!agent.alive) return yield* fail(method, "not_found")
          return agent
        })

      const run: NonNullable<Runtime["run"]> = (terminal, argv) =>
        call(
          "run",
          { terminal: terminal.id, argv: [...argv] },
          terminal.id,
          Effect.gen(function* () {
            if (!HashMap.has(yield* Ref.get(panes), terminal.id)) return yield* fail("run", "not_found")
            const record = HashMap.get(yield* Ref.get(agents), terminal.id)
            if (Option.isNone(record)) return
            yield* updateAgent(terminal.id, (current) => ({ ...current, alive: true, status: "idle" }))
            const session = record.value.vibestSession
            if (session !== undefined) yield* (yield* Ref.get(onStarted))(session)
          }),
        )

      const runtime: Runtime = {
        kind: KIND,
        ...(options.noRun ? {} : { run }),
        status: () =>
          Effect.succeed(
            options.offline === undefined
              ? { status: "online" as const }
              : { status: "offline" as const, reason: options.offline },
          ),
        open: (machine, input) =>
          call(
            "open",
            {
              project: input.project,
              cwd: input.cwd,
              argv: [...input.argv],
              env: { ...input.env },
              label: input.label,
              near: input.near?.id,
              split: input.split,
              focus: input.focus,
              ...(machine.target !== undefined ? { target: machine.target } : {}),
            },
            input.env.VIBEST_SESSION_ID,
            Effect.gen(function* () {
              if (options.startError) return yield* fail("open", "failed", options.startError)
              const near = input.near === undefined ? Option.none() : HashMap.get(yield* Ref.get(panes), input.near.id)
              const grouped = Option.isSome(near)
                ? Option.some(near.value.workspaceId)
                : Option.filter(yield* Effect.option(workspaceAt(input.project)), (id) => id !== undefined)
              const fresh = Option.isNone(grouped)
              let workspaceId: string
              if (fresh) {
                workspaceId = `ws${yield* next()}`
                const opened: Workspace = { path: input.project, root: input.project, open: true }
                yield* Ref.update(workspaces, (map) => HashMap.set(map, workspaceId, opened))
                yield* addPane(`${workspaceId}:root`, workspaceId, input.project)
              } else workspaceId = Option.getOrThrow(grouped)
              let paneId = ""
              let taken = true
              while (taken) {
                const made = yield* next()
                paneId = `${workspaceId}:p${made}`
                taken = HashMap.has(yield* Ref.get(panes), paneId)
              }
              yield* addPane(paneId, workspaceId, input.cwd)
              const session = input.env.VIBEST_SESSION_ID
              const prior =
                session === undefined
                  ? undefined
                  : HashMap.toEntries(yield* Ref.get(agents)).find(([, agent]) => agent.vibestSession === session)?.[1]
              const coordinator = session === undefined && input.argv.some((part) => part.includes("vibest"))
              const started: FakeAgent = {
                ...prior,
                ...(session !== undefined ? { vibestSession: session } : {}),
                status: coordinator ? "working" : "idle",
                seq: 0,
                alive: true,
              }
              yield* Ref.update(agents, (map) => {
                let next = HashMap.set(map, paneId, started)
                if (prior !== undefined)
                  for (const [id, agent] of HashMap.toEntries(map))
                    if (agent.vibestSession === session && id !== paneId) next = HashMap.remove(next, id)
                return next
              })
              void machine
              if (session !== undefined) yield* (yield* Ref.get(onStarted))(session)
              const terminal: Terminal = { machine: "local", id: paneId }
              return terminal
            }),
          ),
        send: (terminal, input) =>
          call(
            "send",
            {
              terminal: terminal.id,
              ...("text" in input && input.text !== undefined ? { text: input.text } : {}),
              ...("keys" in input && input.keys !== undefined ? { keys: [...input.keys] } : {}),
            },
            terminal.id,
            Effect.gen(function* () {
              const agent = yield* agentOf("send", terminal)
              if (
                input.text !== undefined &&
                !options.promptsIgnored &&
                agent.registerPrompt !== false &&
                !(yield* Ref.modify(skipPromptUpdates, (n) => [n > 0, n > 0 ? n - 1 : 0] as const))
              )
                yield* updateAgent(terminal.id, (current) => ({ ...current, status: "working", seq: current.seq + 1 }))
              const interrupts = (input.keys ?? []).some((key) => key === "esc" || key === "ctrl+c")
              if (interrupts && !options.interruptIgnored && (agent.status === "working" || agent.status === "blocked"))
                yield* updateAgent(terminal.id, (current) => ({ ...current, status: "idle", seq: current.seq + 1 }))
            }),
          ),
        read: (terminal, lines) =>
          call(
            "read",
            { terminal: terminal.id, lines },
            terminal.id,
            Effect.flatMap(Ref.get(panes), (map): Effect.Effect<string, R.RuntimeError> =>
              HashMap.has(map, terminal.id)
                ? Effect.succeed("pane tail")
                : new R.RuntimeError({ code: "not_found", message: `read: not_found` }),
            ),
          ),
        process: (terminal) =>
          call(
            "process",
            { terminal: terminal.id },
            terminal.id,
            Effect.gen(function* () {
              if (!HashMap.has(yield* Ref.get(panes), terminal.id)) return yield* fail("process", "not_found")
              const record = HashMap.get(yield* Ref.get(agents), terminal.id)
              if (Option.isSome(record)) return { running: record.value.alive }
              return { running: true }
            }),
          ),
        events: Stream.fromPubSub(events),
        session: (terminal) =>
          call(
            "session",
            { terminal: terminal.id },
            terminal.id,
            Ref.get(agents).pipe(
              Effect.map((map) => HashMap.get(map, terminal.id)),
              Effect.map(
                Option.match({
                  onNone: () => fail("session", "not_found"),
                  onSome: (agent) => Effect.succeed(agent.session ?? null),
                }),
              ),
              Effect.flatten,
            ),
          ),
        state: (terminal) =>
          call(
            "state",
            { terminal: terminal.id },
            terminal.id,
            agentOf("state", terminal).pipe(Effect.map((agent) => agent.status)),
          ),
        close: (terminal) =>
          call(
            "close",
            { terminal: terminal.id },
            terminal.id,
            Effect.gen(function* () {
              const closing = HashMap.get(yield* Ref.get(panes), terminal.id)
              if (Option.isNone(closing)) return yield* fail("close", "not_found")
              yield* Ref.update(panes, (map) => HashMap.remove(map, terminal.id))
              const gone = [terminal.id]
              if (
                Option.isSome(closing) &&
                !HashMap.some(yield* Ref.get(panes), (pane) => pane.workspaceId === closing.value.workspaceId)
              ) {
                const all = yield* Ref.get(workspaces)
                const workspace = HashMap.get(all, closing.value.workspaceId)
                const main =
                  Option.isSome(workspace) &&
                  !workspace.value.standalone &&
                  workspace.value.path === workspace.value.root
                const group = main
                  ? HashMap.toEntries(all)
                      .filter(([, item]) => item.open && !item.standalone && item.root === workspace.value.root)
                      .map(([id]) => id)
                  : [closing.value.workspaceId]
                for (const id of group) gone.push(...(yield* shutWorkspace(id)))
              }
              yield* kill(gone)
              if (options.statusEvents)
                yield* PubSub.publish(events, { type: "exited", terminal: { machine: "local", id: terminal.id } })
            }),
          ),
        present: (terminal, info) =>
          call("present", { terminal: terminal.id, info: { ...info } }, terminal.id, Effect.void),
        seen: (terminal) => markOf(terminal.id),
        see: (terminal, turn) =>
          call(
            "see",
            { terminal: terminal.id, turn },
            terminal.id,
            mark(terminal.id, (now) => ({ ...now, seen: turn })),
          ),
        attach: () => ["fake", "attach"],
        ...(options.noFocus
          ? {}
          : {
              focus: (terminal: { readonly id: string }) =>
                call("focus", { terminal: terminal.id }, terminal.id, Effect.void),
            }),
      }

      return FakeRuntime.of({
        runtime,
        callsTo: (method) =>
          Ref.get(log).pipe(
            Effect.map(
              (entries) =>
                entries.flatMap((entry) => (entry.method === method ? [entry.params] : [])) as unknown as ReadonlyArray<
                  RuntimeCalls[typeof method]
                >,
            ),
          ),
        callCount: Ref.get(callCount),
        terminalOf: (session) =>
          Ref.get(agents).pipe(
            Effect.map((map) => HashMap.toEntries(map).find(([, agent]) => agent.vibestSession === session)?.[0]),
            Effect.map((id) => (id === undefined ? undefined : { machine: "local", id })),
          ),
        agent: (target) =>
          Ref.get(agents).pipe(
            Effect.map((map) => {
              const found = HashMap.toEntries(map).find(
                ([id, agent]) => id === target || agent.vibestSession === target,
              )
              return found === undefined ? undefined : { terminal: found[0], agent: found[1] }
            }),
          ),
        updateAgent,
        endTurn,
        finishTurn: (terminal) => mark(terminal, (now) => ({ ...now, turn: now.turn + 1 })),
        addWorkspace: (id, root, path = root) =>
          Ref.update(workspaces, (map) => HashMap.set(map, id, { path, root, open: true })),
        addPane,
        seedAgent: (terminal) =>
          Effect.gen(function* () {
            yield* addPane(terminal, terminal.split(":")[0] ?? "ws", "/")
            yield* Ref.update(agents, (map) => HashMap.set(map, terminal, { status: "idle", seq: 0, alive: true }))
          }),
        panes: Ref.get(panes),
        workspaceState: Ref.get(workspaces).pipe(
          Effect.map((map) =>
            HashMap.toEntries(map).map(([workspaceId, workspace]) => ({
              workspaceId,
              path: workspace.path,
              root: workspace.root,
              open: workspace.open,
              standalone: workspace.standalone === true,
            })),
          ),
        ),
        hold: (method, target, skip = 0) =>
          Effect.gen(function* () {
            const resolved = target === undefined ? undefined : ((yield* resolve(target)) ?? target)
            const reached = yield* Deferred.make<void>()
            const release = yield* Deferred.make<string | undefined>()
            yield* Ref.update(holds, (map) =>
              HashMap.set(map, method, { target: resolved, raw: target, skip, reached, release }),
            )
            return {
              reached: Deferred.await(reached),
              release: (code?: string) => Deferred.succeed(release, code).pipe(Effect.asVoid),
            }
          }),
        reachable,
        skipPromptUpdates,
        events,
        onStarted,
      })
    })

  static readonly layer = (options: FakeRuntimeOptions = {}) => Layer.effect(FakeRuntime, FakeRuntime.make(options))
}
