import fs from "node:fs/promises"

import { readPing } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Harness, Harnesses, HarnessUnavailable, type HarnessId } from "@vibest/core/harness"
import { BUILTIN } from "@vibest/core/harnesses"

const HARNESS_IDS = Object.keys(BUILTIN)
import { Actions } from "@vibest/core/actions"
import { Agents } from "@vibest/core/agents"
import { Groups } from "@vibest/core/groups"
import * as BuiltinHarnesses from "@vibest/core/harnesses"
import { Inbox } from "@vibest/core/inbox"
import { normalizeModels } from "@vibest/core/models"
import { Layout } from "@vibest/core/paths"
import { type Candidate, Plugins } from "@vibest/core/plugins"
import { type Liveness, Processes } from "@vibest/core/processes"
import { Restarting } from "@vibest/core/restarting"
import { Runtimes, registry } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { systemPromptRoot } from "@vibest/core/system-prompt"
import { TurnEnds, turnEndFrom } from "@vibest/core/turn-ends"
import type * as VibestPlugin from "@vibest/plugin"
import { ActionRefused } from "@vibest/plugin"
import { coordinatorPlugin } from "@vibest/plugin-coordinator"
import { harnessChoicePlugin } from "@vibest/plugin-harness-choice"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { readDaemonInfo } from "@vibest/server/daemon"
import * as GitWorkspace from "@vibest/vibest/workspace"
import { git } from "@vibest/vibest/worktree"
import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  type Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

// Test doubles: an in-memory Runtime, a throwaway git repository, and waiting helpers.
import * as Platform from "#platform"

import { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime.ts"

export { FakeRuntime }

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The runtime kind RPC tests use in place of a connection-scoped Hello. */
export const TEST_HERDR = "herdr"

/** Same socket, different headers: each call carries `headers` and, where the method needs it, TEST_HERDR. */
export const authed = <C extends object>(client: C, headers: Record<string, string>): C =>
  new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return (input: unknown, options?: { headers?: Record<string, string> }) => {
        const payload =
          input !== null &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          !("runtime" in input) &&
          (prop === "Spawn" ||
            prop === "Launch" ||
            prop === "Project.CoordinatorSession" ||
            prop === "Project.RunningCoordinator")
            ? { ...input, runtime: TEST_HERDR }
            : input
        return (value as (payload: unknown, options?: { headers?: Record<string, string> }) => unknown).call(
          target,
          payload,
          { ...options, headers: { ...headers, ...options?.headers } },
        )
      }
    },
  })

/** What the integration does: report a turn end, received `offsetMs` from the (virtual) now. */
export const writeResult = (id: string, harness: string, payload: object, offsetMs = 1000) =>
  Effect.gen(function* () {
    const at = (yield* Clock.currentTimeMillis) + offsetMs
    yield* (yield* TurnEnds).ended(id, turnEndFrom(harness as HarnessId, payload as Record<string, unknown>, at))
  })

/** The latest reported turn end's text for session `id` ("" with none): what a result file held before. */
export const resultText = (id: string) =>
  Effect.gen(function* () {
    return (yield* (yield* TurnEnds).latest(id))?.text ?? ""
  })

/** Whether a turn start was reported for session `id` at or after `at`. */
export const startedSince = (id: string, at: number) =>
  Effect.gen(function* () {
    return yield* (yield* TurnEnds).startedSince(id, at)
  })

/** Forget session `id`'s reported turn end, as if none had come. */
export const dropResult = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* TurnEnds).drop(id)
  })

/** git in tests: a failure is a bug in the test. */
export const sh = (cwd: string, ...args: string[]) => git(cwd, ...args).pipe(Effect.orDie)

/**
 * argv that runs a command (appended after it) at the bottom of a chain of processes, the way a harness runs its hooks.
 * "sh" is a real shell; any other name is this test's executable under that name (a symlink in `dir`, so `ps` shows the
 * name), running the next layer as its child; "launch:<name>" is that process as the one `vibest launch` exec'd: it sets
 * VIBEST_LAUNCH_PID to its own pid.
 */
export const processChain = (dir: string, layers: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const argv: Array<string> = []
    for (const layer of layers) {
      if (layer === "sh") {
        argv.push("sh", "-c", '"$@"; exit $?', "sh")
        continue
      }
      const name = layer.replace(/^launch:/, "")
      const link = path.join(dir, name)
      if (!(yield* fs.exists(link))) yield* fs.symlink(process.execPath, link)
      // Bun named "node" drops the first argument after the script: a filler.
      argv.push(link, "-e", RUN_NEXT, "-", layer === name ? "child" : "launch")
    }
    return argv
  }).pipe(Effect.orDie)

const RUN_NEXT = `const [mode, command, ...args] = process.argv.slice(process.argv.findIndex((a) => a === "child" || a === "launch"))
if (mode === "launch") process.env.VIBEST_LAUNCH_PID = String(process.pid)
process.exitCode = require("node:child_process").spawnSync(command, args, { stdio: "inherit" }).status ?? 1`

/**
 * Run a managed hook script's `action` with `input` on stdin and only the given environment: its stdout and exit code.
 * The test's process runs it, as a harness would, or the process `via` runs it.
 */
export const runHookOutput = (
  file: string,
  input: string,
  env: Record<string, string>,
  action = "stop",
  via: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const PATH = yield* Config.String("PATH")
    const [command, ...args] = [...via, "sh", file, action]
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", yield* withStdin(input, command!, args), {
        env: { PATH, ...env },
        extendEnv: false,
        stdin: "ignore",
      }),
    )
    const [stdout, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
      concurrency: 2,
    })
    return { stdout, code }
  }).pipe(Effect.scoped)

/** The harness conversation saved on coordinator session `sessionId`. */
export const savedSession = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const projectId = yield* db.projectOfSession(sessionId)
    if (projectId === undefined) return null
    const main = yield* db.coordinatorOf(projectId)
    return main?.id === sessionId ? main.harnessSessionId : null
  })

/** Session `sessionId`'s events of `type` (all when omitted), oldest first, with their data. */
export const eventsOf = (sessionId: string, type?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: number; type: string; at: number; data: string }>`SELECT id, type, at, data FROM event
      WHERE session_id = ${sessionId} ${type === undefined ? sql`` : sql`AND type = ${type}`} ORDER BY id`
    return rows.map((r) => ({ id: r.id, type: r.type, at: r.at, data: JSON.parse(r.data) as Record<string, unknown> }))
  }).pipe(Effect.orDie)

/** Why each of session `sessionId`'s processes ended, oldest first (`process.end` reasons). */
export const processEnds = (sessionId: string) =>
  eventsOf(sessionId, "process.end").pipe(Effect.map((rows) => rows.map((r) => r.data.reason)))

/**
 * Each turn as one row, for test queries (`FROM ${sql.literal(TURNS)} m`): `input` is its typed text or the rows
 * delivered into it, `inbox_id` the last of those, `status` `working` while it is open, `end_id` its `turn.end`, and
 * `output` the result row that reports it.
 */
export const TURNS = `(SELECT t.id, t.session_id, t.at AS started_at, te.at AS ended_at, te.id AS end_id,
    (SELECT max(e.inbox_id) FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
      AND json_extract(e.data, '$.to') = 'delivered') AS inbox_id,
    coalesce(json_extract(t.data, '$.typed'), (SELECT group_concat(c, char(10) || char(10)) FROM (SELECT i.content AS c
      FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
        AND json_extract(e.data, '$.to') = 'delivered') ORDER BY i.id)), '') AS input,
    CASE WHEN te.id IS NULL THEN 'working' ELSE json_extract(te.data, '$.status') END AS status,
    (SELECT r.content FROM inbox r WHERE r.result_event_id = te.id) AS output
  FROM event t LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end' WHERE t.type = 'turn.start')`

/** A real-path temp directory, removed with the scope. */
export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

/**
 * `command args` with `input` as stdin, redirected from a file by sh. A test writing to a pipe instead races the
 * process: one that exits without reading (a hook that is not for it, a command that takes no input) leaves the write
 * to fail with an uncaught EPIPE, reported by vitest as an unhandled error.
 */
export const withStdin = (input: string, command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${yield* tempDirectory("vibest-stdin-")}/stdin`
    yield* fs.writeFileString(file, input).pipe(Effect.orDie)
    return ["-c", 'f=$1; shift; exec "$@" <"$f"', "sh", file, command, ...args] as const
  })

const mainTs = `${import.meta.dirname}/../src/main.ts`

/** `vibest ...args` in `cwd` with only the given environment (none of this test runner's VIBEST_* or HERDR_*). */
export const runVibest = (cwd: string, env: Record<string, string>, args: ReadonlyArray<string>, stdin = "") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", yield* withStdin(stdin, process.execPath, [mainTs, ...args]), {
        cwd,
        env: { PATH: yield* Config.String("PATH"), ...env },
        extendEnv: false,
        stdin: "ignore",
      }),
    )
    const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
    const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
      concurrency: 3,
    })
    return { stdout, stderr, code }
  }).pipe(Effect.scoped, Effect.orDie)

/** Built once per process; each test copies it. git init on every test was most of the suite. */
let repositoryTemplate: Promise<string> | undefined
const templateRepository = Effect.promise(() => {
  repositoryTemplate ??= Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectory({ prefix: "vibest-repo-template-" }).pipe(Effect.orDie)
      yield* sh(root, "init", "-q", "-b", "main")
      yield* sh(root, "config", "user.email", "t@example.com")
      yield* sh(root, "config", "user.name", "t")
      yield* fs.writeFileString(path.join(root, "README.md"), "hi\n")
      yield* sh(root, "add", ".")
      yield* sh(root, "commit", "-q", "-m", "init")
      yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "local rules\n")
      return root
    }).pipe(Effect.provide(Platform.services)),
  ).catch((error: unknown) => {
    repositoryTemplate = undefined
    throw error
  })
  return repositoryTemplate
})

/** A repository with one commit and an untracked, not ignored CLAUDE.md (never copied into worktrees). */
export const makeRepository = Effect.gen(function* () {
  const source = yield* templateRepository
  const root = yield* tempDirectory("vibest-repo-")
  yield* Effect.promise(() => fs.cp(source, root, { recursive: true }))
  return root
}).pipe(Effect.orDie)

/** Signal 0, the cwd listing, and SIGTERM, as the test sets them. A PID not set has exited. `terminate` records the PID and marks it exited (unless ignored); it never signals. */
export class FakeProcesses extends Context.Service<
  FakeProcesses,
  {
    readonly set: (pid: number, liveness: Liveness) => Effect.Effect<void>
    /** What the next cwd listings return: PIDs, or undefined (lsof failed). */
    readonly setCwdUsers: (users: ReadonlyArray<number> | undefined) => Effect.Effect<void>
    /** Every PID signal 0 was asked about, in order. */
    readonly probed: Effect.Effect<ReadonlyArray<number>>
    /** Every PID `terminate` was asked to SIGTERM, in order. Never a real signal. */
    readonly signaled: Effect.Effect<ReadonlyArray<number>>
    /** `terminate` returns `denied` and records nothing. */
    readonly setSignalDenied: (denied: boolean) => Effect.Effect<void>
    /** `terminate` is recorded, but the process ignores it: it stays as it was. */
    readonly setSignalIgnored: (ignored: boolean) => Effect.Effect<void>
    /** Hold the next `terminate` until `release`. */
    readonly holdSignal: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    /** Hold the next `cwdUsers`. Owner archive calls it after the borrower list and before git worktree remove. */
    readonly holdCwd: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    /** How long each cwd listing takes (virtual time), like lsof under a high open-file limit. */
    readonly setCwdDelay: (delay: Duration.Input) => Effect.Effect<void>
    readonly processes: Processes["Service"]
  }
>()("test/FakeProcesses") {
  static readonly layer = Layer.effect(
    FakeProcesses,
    Effect.gen(function* () {
      const states = yield* Ref.make(HashMap.empty<number, Liveness>())
      const users = yield* Ref.make<ReadonlyArray<number> | undefined>([])
      const cwdDelay = yield* Ref.make<Duration.Input>(0)
      const probed = yield* Ref.make<ReadonlyArray<number>>([])
      const signaled = yield* Ref.make<ReadonlyArray<number>>([])
      const denied = yield* Ref.make(false)
      const ignored = yield* Ref.make(false)
      const signalGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const cwdGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const holdNext = (gate: typeof cwdGate) =>
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Ref.set(gate, Option.some({ reached, release }))
          return {
            reached: Deferred.await(reached),
            release: () => Deferred.succeed(release, undefined).pipe(Effect.asVoid),
          }
        })
      return FakeProcesses.of({
        set: (pid, liveness) => Ref.update(states, HashMap.set(pid, liveness)),
        setCwdUsers: (u) => Ref.set(users, u),
        probed: Ref.get(probed),
        signaled: Ref.get(signaled),
        setSignalDenied: (d) => Ref.set(denied, d),
        setSignalIgnored: (i) => Ref.set(ignored, i),
        holdSignal: () => holdNext(signalGate),
        holdCwd: () => holdNext(cwdGate),
        setCwdDelay: (d) => Ref.set(cwdDelay, d),
        processes: Processes.of({
          liveness: (pid) =>
            Ref.update(probed, (p) => [...p, pid]).pipe(
              Effect.andThen(Ref.get(states)),
              Effect.map((m) => Option.getOrElse(HashMap.get(m, pid), (): Liveness => "exited")),
            ),
          terminate: (pid) =>
            Effect.gen(function* () {
              const gate = yield* Ref.modify(
                signalGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
                for (let i = 0; i < 8; i++) yield* Effect.yieldNow
              }
              if (yield* Ref.get(denied)) return "denied" as const
              yield* Ref.update(signaled, (s) => [...s, pid])
              if (!(yield* Ref.get(ignored))) yield* Ref.update(states, HashMap.set(pid, "exited" as Liveness))
              return "sent" as const
            }),
          cwdUsers: () =>
            Effect.gen(function* () {
              const gate = yield* Ref.modify(
                cwdGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
              }
              yield* Effect.sleep(yield* Ref.get(cwdDelay))
              return yield* Ref.get(users)
            }),
        }),
      })
    }),
  )
}

export interface TestOptions extends FakeRuntimeOptions {
  /** Harnesses whose vibest plugin is present; all by default. */
  readonly hooked?: ReadonlyArray<HarnessId>
  /** Harnesses whose model listing fails (not logged in); none by default. Usable ones list `fake-model` (default), `fake-strong` and `models`. */
  readonly unusable?: ReadonlyArray<HarnessId>
  readonly models?: ReadonlyArray<string>
  readonly maxSessions?: number
  /** Plugins set up in order, as if found in `~/.vibest/plugins/`. A `{ plugin, options }` entry is that plugin's `context.options`. */
  readonly plugins?: ReadonlyArray<
    | VibestPlugin.Plugin.Plugin
    | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> }
  >
  readonly pluginTimeout?: Duration.Input
  /** Wraps the Db that Sessions, Inbox and the test all see, to stop a call at a chosen point. */
  readonly db?: (db: Db["Service"]) => Db["Service"]
  /** false: a polling harness's integration never asks for its rows (they stay pending, or their lease runs out). */
  readonly integrationPolls?: boolean
}

const harnessOf = (options: TestOptions) =>
  Layer.succeed(Harness, {
    available: () => Effect.succeed(true),
    // A plugin harness (not built in) finds its own integration files: no bundled directory.
    plugin: (id) =>
      !HARNESS_IDS.includes(id)
        ? Effect.succeed("")
        : (options.hooked ?? HARNESS_IDS).includes(id)
          ? Effect.succeed(`/vibest/harnesses/${id}`)
          : Effect.fail(
              new HarnessUnavailable({
                harness: id,
                message: `vibest's ${id} plugin is missing: /vibest/harnesses/${id}`,
              }),
            ),
    models: (id, provider) =>
      options.unusable?.includes(id)
        ? Effect.fail(new HarnessUnavailable({ harness: id, message: "Not logged in" }))
        : Effect.succeed(
            normalizeModels(id, provider, [
              { model: "fake-model", default: true },
              ...["fake-strong", ...(options.models ?? [])].map((model) => ({ model, default: false })),
            ]),
          ),
  })

/** The default harness choice as the product loads it (platform/bun.ts builtinPlugins): first, same source. */
export const harnessChoice: Candidate = {
  source: "builtin:harness-choice",
  revision: "harness-choice",
  options: {},
  plugin: harnessChoicePlugin,
}

/** Sessions, inbox, db and plugins over the fake runtime, registered as the only one. TestClock freezes time, so polls fire only when a test moves it. */
const over = (options: TestOptions) => {
  const runtime = Layer.effect(
    Runtimes,
    Effect.flatMap(FakeRuntime, (fake) => registry([fake.runtime])),
  )
  const home = Layer.effect(Layout, tempDirectory("vibest-home-").pipe(Effect.flatMap(Layout.make)))
  // A TMPDIR of the test's own: system prompts go there, never into the real $TMPDIR/vibest.
  const tmp = Layer.unwrap(
    tempDirectory("vibest-tmp-").pipe(
      Effect.map((dir) =>
        ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: { TMPDIR: dir } }), { asPrimary: true }),
      ),
    ),
  )
  const plugins = Layer.effect(
    Plugins,
    Plugins.make(
      [
        { source: "builtin:coordinator", revision: "coordinator", options: {}, plugin: coordinatorPlugin },
        harnessChoice,
        { source: "test:runtime-choice", revision: "-", options: {}, plugin: choicePlugin() },
        ...(options.plugins ?? []).map((entry) => {
          const plugin = "effect" in entry ? entry : entry.plugin
          const pluginOptions = "effect" in entry ? {} : (entry.options ?? {})
          return { source: `test:${plugin.id}`, revision: "-", options: pluginOptions, plugin }
        }),
      ],
      options.pluginTimeout ? { timeout: options.pluginTimeout } : {},
    ),
  ).pipe(Layer.provideMerge(Subscriptions.layer))
  // The fake harness's integration: it reports ready, with its harness's pid, once `open` or `run` started it (rpc.ts
  // `ready` event).
  const integration = Layer.effectDiscard(
    Effect.gen(function* () {
      const fake = yield* FakeRuntime
      const db = yield* Db
      let pid = 50_000
      yield* Ref.set(fake.onStarted, (session) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.patchLive(session, { ready: at, pid: ++pid }))),
      )
    }),
  )
  // And its turn starts and blocks, as `Sessions.activity` hears them from vibestd (hooks.ts).
  const activity = Layer.effectDiscard(
    Effect.gen(function* () {
      const fake = yield* FakeRuntime
      const sessions = yield* Sessions
      // With no server, the actions that need no caller check (a test with the server installs its own).
      const refused = (e: { readonly message: string }) => new ActionRefused({ reason: e.message })
      const none = Effect.fail(new ActionRefused({ reason: "no server in this test" }))
      yield* (yield* Actions).install({
        send: () => none,
        spawn: () => none,
        archive: ({ id }) => sessions.archiveSettled(id).pipe(Effect.mapError(refused)),
        notice: ({ about, kind, text, to }) => sessions.notice(about, kind, text, to).pipe(Effect.mapError(refused)),
      })
      yield* Ref.set(fake.onActivity, (session, status) =>
        sessions.activity(session, status === "working" ? "working" : { blocked: "permission" }),
      )
      // An integrated harness reports the turn an interrupt key stopped (Claude's aborted turn.complete, Pi's aborted
      // agent_settled), received just after.
      const turnEnds = yield* TurnEnds
      const harnessesOf = yield* Harnesses
      const rows = yield* Db
      yield* Ref.set(fake.onStopped, (session) =>
        Effect.gen(function* () {
          const row = yield* rows.getSession(session)
          if (!row || !harnessesOf.get(row.harnessId).reportsState) return
          const at = (yield* Clock.currentTimeMillis) + 1
          yield* turnEnds.ended(
            session,
            turnEndFrom(row.harnessId, { text: "", aborted: true, error: "interrupted" }, at),
          )
        }),
      )
      // A polling harness's integration (the Claude plugin, the Pi extension) asks for its rows itself: each batch
      // goes into its terminal (recorded as a `send`, as the fake shows a prompt) and is reported taken. Off with
      // `integrationPolls: false` (an integration that never asks).
      if (options.integrationPolls === false) return
      const db = yield* Db
      const harnesses = yield* Harnesses
      yield* Effect.gen(function* () {
        for (const row of yield* db.listSessions()) {
          if (row.agent === "main" || row.address.id === "" || harnesses.find(row.harnessId)?.delivery !== "poll")
            continue
          // Asked only when something waits for it (a real one asks every second), so no lock is taken for nothing.
          if (row.turnState === "open" || (yield* db.pendingInbox(row.id)).length === 0) continue
          // Only a running harness asks.
          const at = yield* fake.agent(row.id)
          if (!at?.agent.alive) continue
          const batch = yield* sessions.poll(row.id)
          if (batch.ids.length === 0) continue
          const taken = yield* fake.runtime.send(row.address, { text: batch.text }).pipe(Effect.exit)
          yield* Exit.isSuccess(taken) ? sessions.consumed(row.id, batch.ids) : sessions.release(row.id, batch.ids)
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`fake integration poll: ${Cause.pretty(cause)}`)),
        Effect.andThen(yieldToIo),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  )
  return Layer.provideMerge(FakeRuntime.layer(options))(
    ((layer) => activity.pipe(Layer.provideMerge(layer)))(
      Layer.effect(Sessions, Sessions.make({ maxSessions: options.maxSessions })).pipe(
        Layer.provideMerge(integration),
        Layer.provideMerge(plugins),
        Layer.provideMerge(Inbox.layer),
        Layer.provideMerge(
          (options.db ? Layer.effect(Db, Effect.map(Db, options.db)).pipe(Layer.provide(Db.layer)) : Db.layer).pipe(
            Layer.provideMerge(Platform.sqlite(":memory:")),
          ),
        ),
        Layer.provideMerge(runtime),
        Layer.provideMerge(harnessOf(options)),
        Layer.provideMerge(BuiltinHarnesses.layer),
        Layer.provideMerge(Agents.layer),
        Layer.provideMerge(Actions.layer),
        Layer.provideMerge(Groups.layer),
        Layer.provideMerge(
          Layer.effect(
            Processes,
            Effect.gen(function* () {
              return (yield* FakeProcesses).processes
            }),
          ).pipe(Layer.provideMerge(FakeProcesses.layer)),
        ),
        Layer.provideMerge(home),
        Layer.provideMerge(tmp),
        Layer.provideMerge(Drain.layer),
        Layer.provideMerge(Restarting.layer),
        Layer.provideMerge(TurnEnds.layer),
        Layer.provideMerge(GitWorkspace.layer),
        Layer.provideMerge(Platform.services),
      ),
    ),
  )
}

/** Session `id`'s system prompt file, under the test's own TMPDIR (testLayer) as vibestd writes it. */
export const systemPromptFile = (id: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, "system-prompt.md")
  })

/** Product tests: the Runtime service is the in-memory fake, not herdr. */
export const testLayer = (options: TestOptions = {}) => over(options)

export type TestServices = Layer.Success<ReturnType<typeof testLayer>> | FakeRuntime

/** A waiting helper ran out of attempts before its condition held. */
export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", { helper: Schema.String }) {}

/** Real wall-clock pause that leaves virtual time where it is (lets git, sqlite and forked fibers make progress). */
const yieldToIo = TestClock.withLive(Effect.sleep("10 millis"))

/** Run `f` until `done` holds, pausing with `step` in between; `GaveUp` after `attempts`. Returns the value that passed. */
const poll = <A, E, R, R2>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Predicate<A>,
  step: Effect.Effect<void, never, R2>,
  attempts: number,
  helper: string,
) =>
  f.pipe(
    Effect.tap((a) => (done(a) ? Effect.void : step)),
    Effect.repeat({ until: done, times: attempts }),
    Effect.filterOrFail(done, () => new GaveUp({ helper })),
  )

/**
 * Wait for background work (a forked launch, an event) until `done` holds, without advancing virtual time. About 20 s of
 * real time at most: git and sqlite under a loaded full-suite run need more than a few seconds, and the 30 s test
 * timeout still bounds a test that would never pass.
 */
export function until<A, B extends A, E, R>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Refinement<A, B>,
): Effect.Effect<B, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>): Effect.Effect<A, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) {
  return poll(f, done, yieldToIo, 2000, "until")
}

/** Advance virtual time in 500 ms steps, letting real I/O run between them, until `done` holds (timeouts, retries). */
export const untilVirtual = <A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) =>
  poll(f, done, yieldToIo.pipe(Effect.andThen(TestClock.adjust("500 millis"))), 200, "untilVirtual")

/** The daemon's Ping answer, retried: one Ping times out after 1 second, which a loaded machine can exceed. */
export const pingOf = (socket: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ping = yield* readPing(socket)
      if (Option.isSome(ping)) return ping.value
      yield* Effect.sleep("250 millis")
    }
    return yield* Effect.die(new Error(`no Ping answer on ${socket}`))
  })

/** vibestd.pid once it records the vibestd `instance`: vibestd writes it just after its socket answers Ping. */
export const recordedInfo = (daemonInfo: string, instance: string | undefined) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const info = yield* readDaemonInfo(daemonInfo)
      if (Option.isSome(info) && info.value.instance === instance) return info.value
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.die(new Error(`${daemonInfo} never recorded vibestd ${instance}`))
  })

/** SIGTERM whatever vibestd `daemonInfo` (a vibestd.pid) names now, and wait for it to exit: a test's own cleanup. */
export const stopRecorded = (daemonInfo: string) =>
  Effect.gen(function* () {
    const running = Option.getOrUndefined(yield* readDaemonInfo(daemonInfo))
    if (!running) return
    yield* Effect.try(() => process.kill(running.pid, "SIGTERM")).pipe(Effect.ignore)
    yield* Effect.sleep("100 millis").pipe(
      Effect.repeat({ until: () => Platform.liveness(running.pid) === "exited", times: 100 }),
    )
  }).pipe(Effect.ignore)
