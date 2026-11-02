// In-memory Runtime (the plugin API of runtime-port.md §3): what the herdr product's tests drive. Terminals are
// pane-style ids (`ws2:p3`); an agent's harness is started by `open` (the argv is recorded, not run), and the state
// machine is the tests' to drive (`updateAgent`, `endTurn`). `open`'s env carries VIBEST_SESSION_ID, so a test may
// address an agent by its session id as well as by its terminal id.
import { Context, Deferred, Effect, HashMap, Layer, Option, PubSub, Ref, Stream } from "effect"
import { Runtime as R } from "@vibest/plugin"

type Runtime = R.Runtime
type Terminal = R.Terminal
type RuntimeError = R.RuntimeError
type RuntimeEvent = R.RuntimeEvent
type AgentState = R.AgentState

/** The kind the fake registers as: the herdr product's tests model herdr. */
export const KIND = "herdr"

export interface FakeAgent {
  /** The vibest session id this terminal's agent serves, from `open`'s env: how tests address it. */
  readonly vibestSession?: string
  /** The harness conversation id the runtime's own record names (a test sets it; herdr knows it from the agent). */
  readonly session?: string
  readonly status: AgentState
  readonly seq: number
  /** false: the pane is still there but the harness process exited. */
  readonly alive: boolean
  /** false: accept `send` and leave seq and status unchanged. */
  readonly registerPrompt?: boolean
}

export interface FakeRuntimeOptions {
  /** `send` with text does not register (exercises the confirm path). */
  readonly promptsIgnored?: boolean
  /** `open` fails with this RuntimeError code. */
  readonly startError?: string
  /** The interrupt key does not stop a working agent (exercises the interrupt timeout). */
  readonly interruptIgnored?: boolean
  /** `events` carries state and exited changes; off (the default), it stays silent and tests drive each check. */
  readonly statusEvents?: boolean
}

/** What a test can read back: one entry per runtime call, in the API's own shapes. */
export interface RuntimeCalls {
  readonly open: { readonly project: string; readonly cwd: string; readonly argv: ReadonlyArray<string>; readonly env: Record<string, string>; readonly label: string; readonly near: string | undefined; readonly split: boolean | undefined; readonly focus: boolean | undefined }
  readonly send: { readonly terminal: string; readonly text?: string; readonly keys?: ReadonlyArray<string> }
  readonly read: { readonly terminal: string; readonly lines: number }
  readonly process: { readonly terminal: string }
  readonly state: { readonly terminal: string }
  readonly session: { readonly terminal: string }
  readonly close: { readonly terminal: string }
  readonly present: { readonly terminal: string; readonly info: Readonly<Record<string, string>> }
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

type Hold = { readonly target: string | undefined; readonly raw: string | undefined; skip: number; readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<string | undefined> }

export class FakeRuntime extends Context.Service<FakeRuntime, {
  readonly runtime: Runtime
  readonly callsTo: <M extends keyof RuntimeCalls>(method: M) => Effect.Effect<ReadonlyArray<RuntimeCalls[M]>>
  /** How many runtime calls have been made. */
  readonly callCount: Effect.Effect<number>
  /** The terminal `open` gave the session (its VIBEST_SESSION_ID), if any. */
  readonly terminalOf: (session: string) => Effect.Effect<Terminal | undefined>
  /** The agent at a terminal or session id: its state and the terminal it runs in, as the tests read it. */
  readonly agent: (target: string) => Effect.Effect<{ readonly terminal: string; readonly agent: FakeAgent } | undefined>
  /** Update an agent by its terminal id or its session id. */
  readonly updateAgent: (target: string, f: (agent: FakeAgent) => FakeAgent) => Effect.Effect<void>
  /** The agent goes idle with a new state sequence, as a finished turn. */
  readonly endTurn: (target: string) => Effect.Effect<void>
  /** A workspace open at the repository's main checkout `root`, or at its linked worktree `path`. */
  readonly addWorkspace: (id: string, root: string, path?: string) => Effect.Effect<void>
  /** A terminal someone else opened in `workspaceId`, with its shell in `cwd`. */
  readonly addPane: (paneId: string, workspaceId: string, cwd: string) => Effect.Effect<void>
  /** A live idle agent at a terminal the test names (a coordinator's terminal, never one `open` made). */
  readonly seedAgent: (terminal: string) => Effect.Effect<void>
  /** Open terminals: id → workspace and cwd. */
  readonly panes: Effect.Effect<HashMap.HashMap<string, { readonly workspaceId: string; readonly cwd: string }>>
  /** Every workspace the fake knows, open or not. */
  readonly workspaceState: Effect.Effect<ReadonlyArray<WorkspaceState>>
  /** Hold the next call to `method` (on `target`, a terminal or session id, if given) until `release`. A code fails it. */
  readonly hold: (method: HoldMethod, target?: string, skip?: number) => Effect.Effect<{ readonly reached: Effect.Effect<void>; readonly release: (code?: string) => Effect.Effect<void> }>
  /** Whether the runtime answers (default yes). No: every call fails `unreachable`, as for a session that is not running. */
  readonly reachable: Ref.Ref<boolean>
  /** The next `n` texts are accepted without moving the agent, so confirm times out. */
  readonly skipPromptUpdates: Ref.Ref<number>
  readonly events: PubSub.PubSub<RuntimeEvent>
}>()("test/FakeRuntime") {
  static readonly make = (options: FakeRuntimeOptions) =>
    Effect.gen(function* () {
      const log = yield* Ref.make<ReadonlyArray<Entry>>([])
      const callCount = yield* Ref.make(0)
      const agents = yield* Ref.make(HashMap.empty<string, FakeAgent>())
      const workspaces = yield* Ref.make(HashMap.empty<string, Workspace>())
      const panes = yield* Ref.make(HashMap.empty<string, { readonly workspaceId: string; readonly cwd: string }>())
      const holds = yield* Ref.make(HashMap.empty<HoldMethod, Hold>())
      const events = yield* PubSub.unbounded<RuntimeEvent>()
      let counter = 0
      const next = () => Effect.sync(() => ++counter)

      const fail = (method: string, code: "not_found" | "busy" | "unreachable" | "incompatible" | "failed", message: string = code) =>
        Effect.fail(new R.RuntimeError({ code, message: `${method}: ${message}` }))

      /** The terminal id of a terminal or session id, as `open`'s env recorded. */
      const resolve = (target: string) =>
        Ref.get(agents).pipe(
          Effect.map((map) => HashMap.toEntries(map).find(([id, agent]) => id === target || agent.vibestSession === target)?.[0]),
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
                    yield* PubSub.publish(events, { type: "state", terminal: { machine: "local", id }, state: after.status })
                  }
                }),
          ),
        )

      const endTurn = (target: string) => updateAgent(target, (agent) => ({ ...agent, status: "idle", seq: agent.seq + 1 }))

      const awaitHold = (method: HoldMethod, target: string | undefined) =>
        Effect.gen(function* () {
          // A session-id hold follows its agent: matched against the terminal it runs in NOW (a move changes it).
          const follows = Option.flatMap(HashMap.get(yield* Ref.get(holds), method), (hold) =>
            hold.raw === undefined ? Option.none<string>() : Option.some(hold.raw))
          const moving = Option.isSome(follows) ? yield* resolve(follows.value) : undefined
          const found = Ref.modify(holds, (map) => {
            const hit = HashMap.get(map, method).pipe(Option.filter((hold) => hold.target === undefined || hold.target === target || hold.raw === target || (moving !== undefined && target === moving)))
            // `skip` lets a call through: the hold starts at the next matching one.
            if (Option.isSome(hit) && hit.value.skip > 0)
              return [Option.none<Hold>(), HashMap.set(map, method, { ...hit.value, skip: hit.value.skip - 1 })] as const
            return [hit, Option.isSome(hit) ? HashMap.remove(map, method) : map] as const
          })
          return yield* found
        }).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.void,
            onSome: (hold) =>
            Deferred.succeed(hold.reached, undefined).pipe(
              Effect.andThen(Deferred.await(hold.release)),
              // A release may name a whole message (a usage-limit text), not one of the five codes: that fails `failed` with it verbatim.
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
          })),
        )

      const call = <M extends keyof RuntimeCalls, A>(method: M, params: RuntimeCalls[M], target: string | undefined, body: Effect.Effect<A, RuntimeError>) =>
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
          // A pane id handed out again is not the old pane: whatever runs there now is not the agent that died in it.
          yield* Ref.update(agents, (map) => HashMap.remove(map, paneId))
        })

      const kill = (paneIds: ReadonlyArray<string>) =>
        Ref.update(agents, (map) => {
          let out = map
          for (const [id, agent] of HashMap.toEntries(map)) if (paneIds.includes(id)) out = HashMap.set(out, id, { ...agent, alive: false })
          return out
        })

      /** The project's workspace: one open at `root`, else the workspace of a terminal whose cwd is `root` (a multi-repository project directory). */
      const workspaceAt = (root: string) =>
        Effect.gen(function* () {
          const grouped = Option.map(HashMap.findFirst(yield* Ref.get(workspaces), (workspace) => workspace.open && workspace.path === root), ([id]) => id)
          if (Option.isSome(grouped)) return grouped.value
          const at = HashMap.toEntries(yield* Ref.get(panes)).find(([, pane]) => pane.cwd === root)
          return at === undefined ? undefined : at[1].workspaceId
        })

      /** Close `id` and drop its terminals. Does not cascade to a repository group; `close` does that. */
      const shutWorkspace = (id: string) =>
        Effect.gen(function* () {
          const workspace = HashMap.get(yield* Ref.get(workspaces), id)
          if (Option.isSome(workspace)) {
            const closed: Workspace = { ...workspace.value, open: false }
            yield* Ref.update(workspaces, (map) => HashMap.set(map, id, closed))
          }
          const inside = HashMap.toEntries(yield* Ref.get(panes)).filter(([, pane]) => pane.workspaceId === id).map(([paneId]) => paneId)
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
          if (!(HashMap.has(yield* Ref.get(panes), terminal.id))) return yield* fail(method, "not_found")
          // An agent whose process is gone is no agent the runtime can name (herdr keeps the record; `state` has no answer).
          if (!agent.alive) return yield* fail(method, "not_found")
          return agent
        })

      const runtime: Runtime = {
        kind: KIND,
        status: () => Effect.succeed({ status: "online" as const }),
        open: (machine, input) =>
          // `open`'s hold target is the vibest session id from the env: a terminal id does not exist yet.
          call("open", { project: input.project, cwd: input.cwd, argv: [...input.argv], env: { ...input.env }, label: input.label, near: input.near?.id, split: input.split, focus: input.focus }, input.env.VIBEST_SESSION_ID,
            Effect.gen(function* () {
              if (options.startError) return yield* fail("open", "failed", options.startError)
              // Kept with the project's others: beside `near`, else in the workspace on the project, else a new one there.
              const near = input.near === undefined ? Option.none() : HashMap.get(yield* Ref.get(panes), input.near.id)
              const grouped = Option.isSome(near) ? Option.some(near.value.workspaceId) : Option.filter(yield* Effect.option(workspaceAt(input.project)), (id) => id !== undefined)
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
              // A resume moves the named agent to the new terminal, as herdr's agent name does: the old pane keeps no record.
              const prior = session === undefined
                ? undefined
                : HashMap.toEntries(yield* Ref.get(agents)).find(([, agent]) => agent.vibestSession === session)?.[1]
              // A terminal running vibest itself is a live coordinator working in it; its registration names it later.
              const coordinator = session === undefined && input.argv.some((part) => part.includes("vibest"))
              const started: FakeAgent = { ...prior, ...(session !== undefined ? { vibestSession: session } : {}), status: coordinator ? "working" : "idle", seq: 0, alive: true }
              yield* Ref.update(agents, (map) => {
                let next = HashMap.set(map, paneId, started)
                if (prior !== undefined) for (const [id, agent] of HashMap.toEntries(map)) if (agent.vibestSession === session && id !== paneId) next = HashMap.remove(next, id)
                return next
              })
              void machine
              const terminal: Terminal = { machine: "local", id: paneId }
              return terminal
            })),
        send: (terminal, input) =>
          call("send", { terminal: terminal.id, ...("text" in input && input.text !== undefined ? { text: input.text } : {}), ...("keys" in input && input.keys !== undefined ? { keys: [...input.keys] } : {}) }, terminal.id,
            Effect.gen(function* () {
              const agent = yield* agentOf("send", terminal)
              // `skipPromptUpdates` counts texts, never key presses (an Enter is not a prompt).
              if (input.text !== undefined && !options.promptsIgnored && agent.registerPrompt !== false && !(yield* Ref.modify(skipPromptUpdates, (n) => [n > 0, n > 0 ? n - 1 : 0] as const)))
                yield* updateAgent(terminal.id, (current) => ({ ...current, status: "working", seq: current.seq + 1 }))
              const interrupts = (input.keys ?? []).some((key) => key === "esc" || key === "ctrl+c")
              if (interrupts && !options.interruptIgnored && (agent.status === "working" || agent.status === "blocked"))
                yield* updateAgent(terminal.id, (current) => ({ ...current, status: "idle", seq: current.seq + 1 }))
            })),
        read: (terminal, lines) =>
          call("read", { terminal: terminal.id, lines }, terminal.id,
            Effect.flatMap(Ref.get(panes), (map): Effect.Effect<string, R.RuntimeError> =>
              HashMap.has(map, terminal.id) ? Effect.succeed("pane tail") : new R.RuntimeError({ code: "not_found", message: `read: not_found` }))),
        process: (terminal) =>
          call("process", { terminal: terminal.id }, terminal.id,
            Effect.gen(function* () {
              if (!HashMap.has(yield* Ref.get(panes), terminal.id)) return yield* fail("process", "not_found")
              // A recorded agent that died left its pane at the shell; a pane with no agent of ours at all is a
              // terminal reused for something else: a program runs there, unnamed.
              const record = HashMap.get(yield* Ref.get(agents), terminal.id)
              if (Option.isSome(record)) return { running: record.value.alive }
              return { running: true }
            })),
        events: Stream.fromPubSub(events),
        session: (terminal) =>
          // The record outlives the process (herdr keeps it): the id is read even after the harness exited.
          call("session", { terminal: terminal.id }, terminal.id,
            Ref.get(agents).pipe(Effect.map((map) => HashMap.get(map, terminal.id)), Effect.map(Option.match({ onNone: () => fail("session", "not_found"), onSome: (agent) => Effect.succeed(agent.session ?? null) })), Effect.flatten)),
        state: (terminal) =>
          call("state", { terminal: terminal.id }, terminal.id,
            // An agent whose process is gone is no agent the runtime can name: herdr keeps the record, but `state` has no answer.
            agentOf("state", terminal).pipe(Effect.map((agent) => agent.status))),
        close: (terminal) =>
          call("close", { terminal: terminal.id }, terminal.id,
            Effect.gen(function* () {
              const closing = HashMap.get(yield* Ref.get(panes), terminal.id)
              if (Option.isNone(closing)) return yield* fail("close", "not_found")
              yield* Ref.update(panes, (map) => HashMap.remove(map, terminal.id))
              // The last pane takes its workspace with it. A main checkout's workspace also takes its linked worktrees' workspaces.
              const gone = [terminal.id]
              if (Option.isSome(closing) && !HashMap.some(yield* Ref.get(panes), (pane) => pane.workspaceId === closing.value.workspaceId)) {
                const all = yield* Ref.get(workspaces)
                const workspace = HashMap.get(all, closing.value.workspaceId)
                const main = Option.isSome(workspace) && !workspace.value.standalone && workspace.value.path === workspace.value.root
                const group = main
                  ? HashMap.toEntries(all).filter(([, item]) => item.open && !item.standalone && item.root === workspace.value.root).map(([id]) => id)
                  : [closing.value.workspaceId]
                for (const id of group) gone.push(...(yield* shutWorkspace(id)))
              }
              yield* kill(gone)
              if (options.statusEvents) yield* PubSub.publish(events, { type: "exited", terminal: { machine: "local", id: terminal.id } })
            })),
        present: (terminal, info) => call("present", { terminal: terminal.id, info: { ...info } }, terminal.id, Effect.void),
        attach: () => ["fake", "attach"],
      }

      return FakeRuntime.of({
        runtime,
        callsTo: (method) => Ref.get(log).pipe(Effect.map((entries) => entries.flatMap((entry) => (entry.method === method ? [entry.params] : [])) as unknown as ReadonlyArray<RuntimeCalls[typeof method]>)),
        callCount: Ref.get(callCount),
        terminalOf: (session) =>
          Ref.get(agents).pipe(
            Effect.map((map) => HashMap.toEntries(map).find(([, agent]) => agent.vibestSession === session)?.[0]),
            Effect.map((id) => (id === undefined ? undefined : { machine: "local", id })),
          ),
        agent: (target) =>
          Ref.get(agents).pipe(
            Effect.map((map) => {
              const found = HashMap.toEntries(map).find(([id, agent]) => id === target || agent.vibestSession === target)
              return found === undefined ? undefined : { terminal: found[0], agent: found[1] }
            }),
          ),
        updateAgent,
        endTurn,
        addWorkspace: (id, root, path = root) => Ref.update(workspaces, (map) => HashMap.set(map, id, { path, root, open: true })),
        addPane,
        seedAgent: (terminal) =>
          Effect.gen(function* () {
            yield* addPane(terminal, terminal.split(":")[0] ?? "ws", "/")
            yield* Ref.update(agents, (map) => HashMap.set(map, terminal, { status: "idle", seq: 0, alive: true }))
          }),
        panes: Ref.get(panes),
        workspaceState: Ref.get(workspaces).pipe(
          Effect.map((map) => HashMap.toEntries(map).map(([workspaceId, workspace]) => ({
            workspaceId, path: workspace.path, root: workspace.root, open: workspace.open, standalone: workspace.standalone === true,
          }))),
        ),
        hold: (method, target, skip = 0) =>
          Effect.gen(function* () {
            // Both forms match: the raw string (a session id, as `open` reports it) and the terminal it names now.
            const resolved = target === undefined ? undefined : (yield* resolve(target)) ?? target
            const reached = yield* Deferred.make<void>()
            const release = yield* Deferred.make<string | undefined>()
            yield* Ref.update(holds, (map) => HashMap.set(map, method, { target: resolved, raw: target, skip, reached, release }))
            return { reached: Deferred.await(reached), release: (code?: string) => Deferred.succeed(release, code).pipe(Effect.asVoid) }
          }),
        reachable,
        skipPromptUpdates,
        events,
      })
    })

  static readonly layer = (options: FakeRuntimeOptions = {}) => Layer.effect(FakeRuntime, FakeRuntime.make(options))
}
