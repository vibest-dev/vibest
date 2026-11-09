import {
  awaitDaemon,
  type Claim,
  claimHeaders,
  cliHeaders,
  connect,
  described,
  hookCall,
  importCheck,
  type VibestClient,
  probe,
  protocolHeaders,
  readPing,
  runCaptured,
  startDaemon,
  withVibest,
} from "@vibest/client/client"
import * as Guard from "@vibest/core/guard"
import { type HarnessAdapter, Harnesses, HARNESS_IDS, type HarnessId } from "@vibest/core/harness"
import { catalogModels } from "@vibest/core/models"
import { askLine, askYesNo, interactive, Layout, shellQuote, VibestCommand, writeAtomic } from "@vibest/core/paths"
import { makeSources } from "@vibest/core/plugin-sources"
import { DEFAULT_TIMEOUT, describeSpawn, PluginLoader, type Candidate } from "@vibest/core/plugins"
import { ProjectKind } from "@vibest/core/project"
import { jsonObject, promptOf } from "@vibest/core/results"
import { shortId } from "@vibest/schema/id"
import * as Daemon from "@vibest/server/daemon"
import {
  Cause,
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  type Runtime,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcClientError as ClientError } from "effect/rpc"

import { herdrCommands } from "./herdr-plugin.ts"
import { type ReplaceFailed, replaceAnyway, replaceDaemon, compareVersions, versionOf } from "./replace.ts"
export { compareVersions }
import { LaunchFailed } from "@vibest/core/sessions"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { Forbidden, type Ping, VERSION } from "@vibest/protocol/rpc"

export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const agentName = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
  const coordinatorCwd = agentName === "coordinator" ? { repositoryRoot } : {}
  const claim: Claim = sessionId ? { _tag: "session", sessionId, ...coordinatorCwd } : { _tag: "cli", repositoryRoot }
  return { claim, agent: sessionId !== undefined }
})

export const userOnly = (command: string) =>
  Effect.flatMap(caller, (c) =>
    c.agent
      ? Effect.fail(
          new Forbidden({
            method: command || "vibest",
            message: `an agent may not run vibest${command ? ` ${command}` : ""}; ask the user to`,
          }),
        )
      : Effect.void,
  )

const vibest = <A, E, R>(f: (client: VibestClient, agent: boolean) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(caller, (c) => withVibest(c.claim, (client) => f(client, c.agent), { start: !c.agent }))

const requested = <A, E, R>(
  f: (
    client: VibestClient,
    request: string | undefined,
    ping: Ping,
  ) => Effect.Effect<A, E | ClientError.RpcClientError, R>,
) =>
  Effect.gen(function* () {
    const c = yield* caller
    const socket = (yield* Layout).socket
    const request = crypto.randomUUID()
    let known = false
    const call = (firstError?: ClientError.RpcClientError) =>
      withVibest(
        c.claim,
        (client, ping) => {
          known = ping.capabilities?.requests === true
          return firstError !== undefined && !known
            ? Effect.fail(firstError)
            : f(client, known ? request : undefined, ping)
        },
        { start: !c.agent },
      )
    return yield* call().pipe(
      Effect.catch((error) =>
        known && error instanceof ClientError.RpcClientError
          ? awaitDaemon(socket).pipe(Effect.andThen(call(error)))
          : Effect.fail(error),
      ),
    )
  })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const json = (value: unknown) => Console.log(encodeJson(value))

const input = (value: string, what: string) =>
  Effect.gen(function* () {
    const text = value === "-" ? yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)) : value
    if (text.trim() === "") return yield* new EmptyInput({ message: `the ${what} is empty` })
    return text
  })
const text = (name: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(
      "Literal text, or - to read it from stdin. Put -- before it so text starting with - is not read as an option",
    ),
  )

const id = Argument.String("id").pipe(
  Argument.withDescription("session id, or a unique prefix of at least 8 of its characters (as vibest shows ids)"),
)
const sessionFlag = Flag.String("session").pipe(
  Flag.withDescription(
    "The herdr session to use, overriding the ambient herdr session when run inside herdr (default vibest); bare `vibest` refuses it inside herdr",
  ),
  Flag.optional,
)

const daemon = (host: Daemon.Host) =>
  Command.make(
    "daemon",
    {
      foreground: Flag.Boolean("foreground").pipe(
        Flag.withDescription("Run vibestd in this process"),
        Flag.withDefault(false),
      ),
      handoff: Flag.Boolean("import").pipe(Flag.withHidden, Flag.withDefault(false)),
    },
    ({ foreground, handoff }) =>
      userOnly("daemon").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (foreground) {
              delete process.env[Daemon.HANDOFF_ENV]
              return yield* Daemon.run(host, { handoff })
            }
            const layout = yield* Layout
            if (!(yield* probe(layout.socket))) yield* startDaemon
            yield* Console.log(`vibestd is running on ${layout.socket}`)
          }),
        ),
      ),
  ).pipe(
    Command.withDescription("Start vibestd (in the background unless --foreground); exits 0 if it is already running"),
    Command.withSubcommands([
      Command.make("restart", {}, () =>
        userOnly("daemon restart").pipe(
          Effect.andThen(Effect.flatMap(VibestCommand, (command) => replaceDaemon({ version: VERSION, command }))),
          Effect.andThen(restartAgents(VERSION, false, "vibest daemon restart")),
          Effect.flatMap((failed) =>
            failed === undefined ? Effect.void : Effect.fail(new UpdateError({ message: failed })),
          ),
          Effect.catchIf(
            (e) => e._tag === "ReplaceFailed" && e.outcome === "declined",
            () => Console.log(`${LEFT.declined}.`),
          ),
        ),
      ).pipe(
        Command.withDescription(
          "Replace the running vibestd with this vibest, after a yes on a terminal; agents keep running and queued messages are kept, but unfinished daemon operations may refuse the restart. Then offers to restart the agents on another integration in place, with their conversations",
        ),
      ),
      Command.make("import-check", {}, () =>
        userOnly("daemon import-check").pipe(Effect.andThen(Daemon.checkImport(host))),
      ),
    ]),
  )

const run = Command.make(
  "run",
  {
    harness: Argument.Literals("harness", [...HARNESS_IDS, "auto"] as const).pipe(
      Argument.withDescription("auto: let spawn plugins choose"),
    ),
    prompt: text("prompt"),
    title: Flag.String("title").pipe(
      Flag.withDescription(
        "What the agent does, in a few words (its pane title, and the line its results show); default: the task's start",
      ),
      Flag.optional,
    ),
    provider: Flag.String("provider").pipe(Flag.optional),
    model: Flag.String("model").pipe(
      Flag.withDescription("Leave out for the harness default; see vibest models"),
      Flag.optional,
    ),
    env: Flag.KeyValuePair("env").pipe(
      Flag.withDescription(
        "KEY=VALUE for the harness, never stored: a restart or a harness change in the same pane keeps it, a new pane (the old one closed) does not; pass it again then",
      ),
      Flag.optional,
    ),
    peer: Flag.String("peer").pipe(
      Flag.withDescription(
        "A session id (or a unique prefix of at least 8 characters): run in its directory, in a pane split from its pane, instead of a new worktree (the directory goes with the archive of the last live session in it)",
      ),
      Flag.optional,
    ),
    archive: Flag.Boolean("archive-on-completion").pipe(
      Flag.withDescription(
        "Archive the session once it reports completed and that result reached you (as vibest archive: branch kept, worktree removed only when git loses nothing)",
      ),
      Flag.withDefault(false),
    ),
    runtime: Flag.String("runtime").pipe(
      Flag.withDescription("The terminal runtime for this session. Default: its parent's"),
      Flag.optional,
    ),
    session: sessionFlag,
  },
  (o) =>
    Effect.gen(function* () {
      const prompt = yield* input(o.prompt, "prompt")
      const spawned = yield* requested((client, request, ping) =>
        Effect.gen(function* () {
          if (Option.isSome(o.runtime) && ping.capabilities?.spawnRuntime !== true)
            return yield* new LaunchFailed({
              message: "this vibestd does not take --runtime on vibest run; run vibest update",
            })
          return yield* client.Spawn({
            ...(request === undefined ? {} : { request }),
            harness: o.harness === "auto" ? undefined : o.harness,
            prompt,
            name: Option.getOrUndefined(o.title),
            provider: Option.getOrUndefined(o.provider),
            model: Option.getOrUndefined(o.model),
            env: Option.getOrUndefined(o.env),
            peer: Option.getOrUndefined(o.peer),
            archive: o.archive || undefined,
            runtime: Option.getOrUndefined(o.runtime),
            callerEnv: callerEnvOf(),
            ...(Option.isNone(o.session) ? {} : { runtimeSession: o.session.value }),
          })
        }),
      )
      yield* json(spawned)
    }),
).pipe(
  Command.withDescription(
    "Start a session on a task and print its id at once. The coordinator gets the result as a message when the session's turn ends; anyone else reads it with vibest result. vibest makes each session its own worktree (detached, no branch); in a project of several repositories (a directory of git repositories) that is one worktree of every repository, side by side. The main agent may run it from anywhere in its project, also from inside one repository. Never tell the session to make its own worktree, clone or copy",
  ),
)

export const soleMainAgent = <A, E, R>(
  client: Pick<VibestClient, "Project.RunningCoordinator" | "Project.StopCoordinator">,
  terminal: string,
  start: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const running = yield* client["Project.RunningCoordinator"]({ terminal })
    if (running) {
      const where = `the main agent (${running.harness}) runs in ${running.place}`
      const question = `The main agent (${running.harness}) runs in ${running.place}. Move it here and continue? [y/N]: `
      if (!((yield* interactive) && (yield* askYesNo(question))))
        return yield* new LaunchFailed({
          message: `not starting: ${where}, and a project has one main agent. Exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
        })
      const stopped = yield* client["Project.StopCoordinator"]({ runtime: running.runtime, address: running.address })
      if (stopped.result === "moved")
        return yield* new LaunchFailed({ message: "not starting: the main agent moved meanwhile; run vibest again" })
      if (stopped.result === "unsupported")
        return yield* new LaunchFailed({
          message: `not starting: ${where} and cannot be moved from here: ${stopped.reason}. Exit it there first`,
        })
      if (stopped.result === "running")
        return yield* new LaunchFailed({
          message: `not starting: ${where} and did not exit; nothing changed. Exit it there first`,
        })
    }
    return yield* start
  })

export const openProject = (client: Pick<VibestClient, "Project.Open">) =>
  Effect.gen(function* () {
    const opened = yield* client["Project.Open"]({}).pipe(
      Effect.catchTag("ProjectMoved", (moved) =>
        Effect.gen(function* () {
          const refused = new LaunchFailed({
            message: `not starting: ${moved.message} on an interactive terminal (nothing changed)`,
          })
          if (!(yield* interactive)) return yield* refused
          const line = yield* askLine(`The project moved from ${moved.from} to here, move it? [Y/n]: `)
          const answer = Option.getOrUndefined(line)?.trim().toLowerCase()
          if (answer === undefined || !["", "y", "yes", "n", "no"].includes(answer)) return yield* refused
          return yield* client["Project.Open"]({ move: answer === "" || answer.startsWith("y") })
        }),
      ),
    )
    if (opened.moved !== undefined) {
      yield* Console.error(`moved the project from ${opened.moved.from} to ${opened.directory}`)
      for (const command of opened.moved.manual)
        yield* Console.error(`a worktree of yours still names the old place; to repair it, run: ${command}`)
    }
    if (opened.candidates !== undefined)
      yield* Console.error(
        `a new project here: more than one moved project had these origins (${opened.candidates.join(", ")})`,
      )
    return opened
  })

export type Exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => void

const mainFlags = {
  fresh: Flag.Boolean("new").pipe(
    Flag.withDescription("Start a new conversation with the main agent instead of reopening the current one"),
    Flag.withDefault(false),
  ),
  harness: Flag.Literals("harness", HARNESS_IDS).pipe(
    Flag.withDescription("Leave out for the main agent's current harness, or what scheduling plugins choose"),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(Flag.optional),
  model: Flag.String("model").pipe(Flag.optional),
  session: sessionFlag,
  headless: Flag.Boolean("headless").pipe(
    Flag.withDescription("Outside herdr: do not attach to the session"),
    Flag.withDefault(false),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      "The terminal runtime the main agent runs in. Overrides the runtime this terminal's environment detects; required when none is detected",
    ),
    Flag.optional,
  ),
  inParent: Flag.String("in-parent").pipe(Flag.withHidden, Flag.optional),
}

export const callerPlugins = (builtins: ReadonlyArray<Candidate>) =>
  Effect.gen(function* () {
    const loader = yield* PluginLoader
    yield* loader.prepare
    const read = yield* (yield* makeSources(DEFAULT_TIMEOUT, { quiet: true })).read
    return [...builtins, ...read.candidates]
  })

const callerEnvOf = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const startMain =
  (exec: Exec, _host: Daemon.Host) =>
  (o: {
    readonly fresh: boolean
    readonly harness: Option.Option<HarnessId>
    readonly provider: Option.Option<string>
    readonly model: Option.Option<string>
    readonly session: Option.Option<string>
    readonly headless: boolean
    readonly runtime: Option.Option<string>
    readonly inParent: Option.Option<string>
  }) =>
    Effect.gen(function* () {
      yield* userOnly("")
      if (Option.isNone(o.inParent)) yield* updateNotice
      const harness = Option.getOrUndefined(o.harness)
      const provider = Option.getOrUndefined(o.provider)
      const model = Option.getOrUndefined(o.model)
      const runtimeKind = Option.getOrUndefined(o.runtime)
      const again = [
        ...(yield* VibestCommand),
        ...(harness ? ["--harness", harness] : []),
        ...(provider ? ["--provider", provider] : []),
        ...(model ? ["--model", model] : []),
        ...(runtimeKind ? ["--runtime", runtimeKind] : []),
        ...(o.fresh ? ["--new"] : []),
      ]
      const claim = (yield* caller).claim
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      if (Option.isNone(o.inParent)) yield* withVibest(claim, openProject)
      const placed = yield* withVibest(claim, (client) =>
        client["Project.MainPlace"]({
          callerEnv: callerEnvOf(),
          ...(runtimeKind === undefined ? {} : { runtime: runtimeKind }),
          ...(Option.isNone(o.inParent) ? {} : { inParent: o.inParent.value }),
        }),
      )
      const foreignSession = Option.match(o.session, {
        onNone: () => undefined,
        onSome: (name) =>
          new LaunchFailed({
            message: `--session ${name} names a herdr session; inside herdr this pane's own session is used. Run vibest outside herdr, or drop --session`,
          }),
      })
      if (placed.place.in === "launch") {
        const opened = yield* withVibest(claim, (client) =>
          client.Launch({
            argv: again,
            focus: !o.headless,
            runtime: placed.place.runtime,
            callerEnv: callerEnvOf(),
            ...(Option.isNone(o.session) ? {} : { runtimeSession: o.session.value }),
          }),
        )
        yield* Console.log(`the main agent is starting in ${opened.place}`)
        if (o.headless || !opened.attach) return
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const [file, ...args] = opened.attach
        yield* spawner.exitCode(
          ChildProcess.make(file!, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
        )
        return
      }
      if (foreignSession !== undefined) return yield* foreignSession
      if ((yield* fs.realPath(path.resolve("."))) !== placed.directory)
        yield* Effect.sync(() => process.chdir(placed.directory))
      const terminal = placed.place.terminal
      const chosen = yield* withVibest(claim, (client) =>
        client["Project.StartMain"]({
          harness,
          provider,
          model,
          runtime: placed.place.runtime,
        }),
      )
      if (Object.keys(chosen.decidedBy).length > 0) yield* Console.error(`main agent: ${describeSpawn(chosen)}`)
      const started = yield* withVibest(claim, (client) =>
        soleMainAgent(
          client,
          terminal,
          client["Project.CoordinatorSession"]({
            harness: chosen.harness,
            fresh: o.fresh,
            terminal,
            runtime: chosen.runtime,
            provider: chosen.provider,
            model: chosen.model,
            routing: { decidedBy: chosen.decidedBy, trace: chosen.trace },
            pid: process.pid,
          }),
        ),
      )
      return yield* Effect.sync(() => exec(started.command.file, started.command.args, started.command.env))
    })

const send = Command.make("send", { id, message: text("message") }, (o) =>
  Effect.gen(function* () {
    const message = yield* input(o.message, "message")
    const sent = yield* requested((client, request) =>
      client.Send({ id: o.id, message, ...(request === undefined ? {} : { request }) }),
    )
    yield* json({ id: sent.id, queued: true })
  }),
).pipe(
  Command.withDescription(
    "Continue a session: queue a message, delivered once it is idle (never interrupts a turn); prints at once",
  ),
)

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    yield* updateNotice
    const layout = yield* Layout
    const info = yield* Daemon.readDaemonInfo(layout.daemonInfo)
    const ping = yield* connect(layout.socket).pipe(
      Effect.flatMap((client) => client.Ping(undefined)),
      Effect.timeout("1 second"),
      Effect.option,
      Effect.scoped,
    )
    yield* json({
      client: { version: VERSION, command: yield* VibestCommand },
      daemon: Option.match(ping, {
        onNone: () => ({ status: "not running", socket: layout.socket }),
        onSome: (p) => ({
          status: "running",
          pid: p.pid ?? null,
          instance: p.instance ?? null,
          command: p.command ?? null,
          startedAt: p.startedAt ?? null,
          version: p.version,
          sameVersion: p.version === VERSION,
          protocol: p.protocol ?? null,
          socket: layout.socket,
          recordedPid: Option.getOrNull(Option.map(info, (i) => i.pid)),
        }),
      }),
      runtimes: Option.getOrNull(Option.map(ping, (p) => p.runtimes ?? null)),
    })
  }),
).pipe(
  Command.withDescription(
    "vibest's status: this client, vibestd (running or not; never started by this) and the terminal runtimes it has",
  ),
)

const titled = <S extends { readonly name: string }>({ name, ...rest }: S) => ({ title: name, ...rest })

const result = Command.make("result", { id }, (o) =>
  vibest((client) => client.Get({ id: o.id })).pipe(Effect.map(titled), Effect.flatMap(json)),
).pipe(Command.withDescription("A session's latest result (JSON; null before its first)"))

const interrupt = Command.make("interrupt", { id }, (o) =>
  vibest((client) => client.Interrupt({ id: o.id })).pipe(Effect.flatMap(json)),
).pipe(
  Command.withDescription(
    "Interrupt a session's running turn; the session stays for follow-ups (no result arrives for that turn)",
  ),
)

const peek = Command.make(
  "peek",
  {
    id,
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("How many of the last lines to print (at most 500; vibestd's default is 30)"),
      Flag.optional,
    ),
  },
  (o) =>
    vibest((client) => client.Peek({ id: o.id, lines: Option.getOrUndefined(o.lines) })).pipe(
      Effect.flatMap((r) => Console.log(r.text)),
    ),
).pipe(
  Command.withDescription(
    "Print the last lines on a session's terminal, read now (plain text). Results never carry screen text: look here when one says the turn ended without a report or did not start",
  ),
)

const archive = Command.make(
  "archive",
  {
    id,
    keepWorktree: Flag.Boolean("keep-worktree").pipe(
      Flag.withDescription("Archive the session but keep its worktree"),
      Flag.withDefault(false),
    ),
  },
  (o) => vibest((client) => client.Remove({ id: o.id, keepWorktree: o.keepWorktree })).pipe(Effect.flatMap(json)),
).pipe(
  Command.withAlias("rm"),
  Command.withDescription(
    "Archive an agent session (a working one is interrupted for up to 10 s, then its pane closed and that turn's result lost; releases terminal pane, workspace, and clean worktree; retains the session row, inbox history, and stored results)",
  ),
)

const ls = Command.make(
  "ls",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Exited sessions too"),
      Flag.withDefault(false),
    ),
  },
  (o) =>
    Effect.gen(function* () {
      yield* vibest((client) => client.List({ stopped: o.all })).pipe(
        Effect.map((sessions) => sessions.map(titled)),
        Effect.flatMap(json),
      )
    }),
).pipe(
  Command.withDescription(
    "Your sessions that have not exited, as JSON: each task (cut to 500 characters), its live status, and its latest result (--all: exited ones too). vibest result keeps the full task",
  ),
)

const report = Command.make("report", { message: text("message") }, (o) =>
  Effect.gen(function* () {
    const message = yield* input(o.message, "message")
    yield* vibest((client) => client.Report({ message }))
    yield* json({ sent: true })
  }),
).pipe(
  Command.withDescription(
    "Sessions only: send a progress report or question to the coordinator that gave you your task",
  ),
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Only this provider's models; a harness with no provider option refuses it"),
  Flag.optional,
)
const catalog = Effect.flatMap(caller, (c) =>
  withVibest(c.claim, (client) => client["Harnesses.List"](), {
    start: !c.agent,
    needs: { capability: "harnesses", method: "Harnesses.List" },
  }),
)
const modelsOf = (harnesses: ReadonlyArray<HarnessId>, provider: Option.Option<string>) =>
  Effect.gen(function* () {
    const adapters = yield* Harnesses
    const choices = (yield* catalog).filter((c) => harnesses.includes(c.harness))
    yield* json(catalogModels(choices, adapters, Option.getOrNull(provider)))
  })

const models = Command.make(
  "models",
  {
    target: Argument.Literals("harness", HARNESS_IDS).pipe(
      Argument.withDescription("Only this harness's models"),
      Argument.optional,
    ),
    harness: Flag.Literals("harness", HARNESS_IDS).pipe(
      Flag.withDescription("Same as the harness argument"),
      Flag.optional,
    ),
    provider: providerFlag,
  },
  (o) =>
    modelsOf(
      Option.match(
        Option.orElse(o.target, () => o.harness),
        { onNone: () => HARNESS_IDS, onSome: (h) => [h] },
      ),
      o.provider,
    ),
).pipe(
  Command.withDescription(
    "The models each harness accepts, as the harness reports them: start a session with one entry's harness, provider (null: leave it out) and model",
  ),
)

const harness = Command.make("harness").pipe(
  Command.withDescription("The harnesses vibest runs"),
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.gen(function* () {
        const adapters = yield* Harnesses
        const choices = yield* catalog
        yield* json(
          choices.map((c) => ({
            harness: c.harness,
            binary: adapters.get(c.harness).binary,
            available: c.problem === null,
            defaultModel: c.models.find((m) => m.default)?.model ?? null,
            error: c.problem,
          })),
        )
      }),
    ).pipe(
      Command.withAlias("ls"),
      Command.withDescription(
        "Each harness: its binary, whether vibest can start it and the model it runs by default (null: the harness chooses; error says why it cannot be started)",
      ),
    ),
    Command.make("models", { harness: Argument.Literals("harness", HARNESS_IDS), provider: providerFlag }, (o) =>
      modelsOf([o.harness], o.provider),
    ).pipe(Command.withDescription("The models one harness accepts; same JSON as vibest models")),
  ]),
)

const project = Command.make("project").pipe(
  Command.withDescription(
    "This repository's project folder (VIBEST_PROJECT_DIR for agents): preferences.md, docs/, memories/ and artifacts/, read and written with file tools",
  ),
  Command.withSubcommands([
    Command.make(
      "create",
      {
        directory: Argument.String("directory").pipe(
          Argument.withDescription("The project directory to create (or an empty directory to use)"),
        ),
        from: Flag.String("from").pipe(
          Flag.withDescription("A git repository to copy in, as a folder named after it. Repeat for each repository"),
          Flag.atLeast(1),
        ),
      },
      (o) =>
        Effect.gen(function* () {
          yield* userOnly("project create")
          const created = yield* vibest((client) =>
            client["Project.Create"]({ directory: o.directory, from: [...o.from] }),
          )
          for (const folder of created.folders) {
            if (folder.uncommitted.length === 0) continue
            yield* Console.error(
              `warning: ${folder.source}: uncommitted changes were not copied:\n${folder.uncommitted.map((line) => `  ${line}`).join("\n")}`,
            )
          }
          yield* json(created)
        }),
    ).pipe(
      Command.withDescription(
        "Only for working on several repositories together; a single git repository is already a project (cd into it and run vibest). Copies them into a new project directory, one folder each: `vibest project create ~/work/combo --from ~/code/shop --from ~/code/admin` makes ~/work/combo/shop and ~/work/combo/admin (your originals are untouched); ~/work/combo itself must not be inside a git repository. Then `cd ~/work/combo && vibest`: the main agent works there, and each subagent gets its own copy with the same folders. An agent may not run it",
      ),
    ),
    Command.make("info", {}, () => vibest((client) => client["Project.Info"]()).pipe(Effect.flatMap(json))).pipe(
      Command.withDescription("The paths of the project folder, its preferences.md, docs, memories and artifacts"),
    ),
    Command.make(
      "search",
      { query: Argument.String("query"), kind: Flag.Literals("kind", ProjectKind.literals).pipe(Flag.optional) },
      (o) =>
        vibest((client) => client["Project.Search"]({ query: o.query, kind: Option.getOrUndefined(o.kind) })).pipe(
          Effect.flatMap((hits) => json({ hits })),
        ),
    ).pipe(Command.withDescription("Case-insensitive text search; hits are kind/path:line: text")),
  ]),
)

const plugins = Command.make("plugins", {}, () => vibest((client) => client.Plugins().pipe(Effect.flatMap(json)))).pipe(
  Command.withDescription(
    "List the plugins vibestd loaded (from ~/.vibest/plugins and vibest.json) with their hook counters since it started",
  ),
)

const subscriptions = Command.make("subscriptions", {}, () =>
  vibest((client) => client.Subscriptions().pipe(Effect.flatMap(json))),
).pipe(Command.withDescription("Print each harness login and its usage limits, as vibestd last read them"))

const nonempty = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map((value) => {
      const text = Option.getOrUndefined(value)
      return text ? text : undefined
    }),
  )

const notify = (
  adapter: HarnessAdapter,
  sessionId: string,
  raw: string,
  what: string,
  send: (client: VibestClient) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const event = jsonObject(raw)
    const harnessSessionId = event && adapter.conversationOf?.(event)
    const headers = yield* claimHeaders({
      _tag: "session",
      sessionId,
      ...(harnessSessionId ? { harnessSessionId } : {}),
    })
    const exit = yield* hookCall(layout.socket, headers, send)
    if (Exit.isSuccess(exit)) return
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    const cause = Cause.squash(exit.cause)
    return yield* Effect.fail(
      `${at} vibest: ${adapter.id} ${what} of session ${sessionId} did not reach vibestd: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  })

const hookSession = Effect.gen(function* () {
  const agent = yield* nonempty("VIBEST_AGENT")
  const sessionId = yield* nonempty("VIBEST_SESSION_ID")
  return agent && sessionId ? { agent, sessionId } : undefined
})

export const integrationStop = (adapter: HarnessAdapter, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    const event = jsonObject(raw)
    if (!event || !adapter.turnEnd?.(event, who.agent === "coordinator")) return
    yield* notify(adapter, who.sessionId, raw, "turn end", (client) =>
      client.TurnEnd({ sessionId: who.sessionId, harness: adapter.id, event: raw }),
    )
  })

export const integrationPrompt = (adapter: HarnessAdapter, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who || promptOf(adapter, who.agent, raw) === undefined) return
    yield* notify(adapter, who.sessionId, raw, "turn start", (client) =>
      client.Prompt({ sessionId: who.sessionId, harness: adapter.id, event: raw }),
    )
  })

export const integrationReady = (adapter: HarnessAdapter, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(adapter, who.sessionId, raw, "ready report", (client) =>
      client["Session.Ready"]({ id: who.sessionId }),
    )
  })

const hookHarness = Flag.Literals("harness", HARNESS_IDS).pipe(Flag.withDescription("The harness whose hook this is"))

const hookCommand = <E, R>(
  name: string,
  report: (adapter: HarnessAdapter, raw: string) => Effect.Effect<void, E, R>,
  description: string,
) =>
  Command.make(name, { harness: hookHarness }, (o) =>
    Effect.gen(function* () {
      yield* report(
        (yield* Harnesses).get(o.harness),
        yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)),
      )
    }),
  ).pipe(Command.withDescription(description))

const stop = hookCommand(
  "stop",
  integrationStop,
  "A harness plugin's turn-end bridge: its turn-end event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const prompt = hookCommand(
  "prompt",
  integrationPrompt,
  "A harness plugin's turn-start bridge: its prompt or activity event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const ready = hookCommand(
  "ready",
  integrationReady,
  "A harness plugin's session-start bridge: tells vibestd the session takes input. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const guard = Command.make("guard", { harness: hookHarness }, (o) =>
  Effect.gen(function* () {
    const { guardAnswer } = (yield* Harnesses).get(o.harness)
    if (!guardAnswer) return yield* Effect.fail(new Error(`${o.harness} has no pre-tool hook`))
    const agent = yield* Config.String("VIBEST_AGENT")
    const answer = guardAnswer(
      yield* Guard.check(agent, yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin))),
    )
    if (answer !== undefined) yield* json(answer)
  }),
).pipe(
  Command.withDescription(
    "Pre-tool hook: reads the harness's pre-tool input on stdin, prints its answer when the rules of the agent in VIBEST_AGENT refuse the call",
  ),
)

const integration = () =>
  Command.make("integration").pipe(
    Command.withDescription(
      "Internal: called by vibest's plugin in each harness (user prompt, turn-end result, pre-tool guard); not for direct use",
    ),
    Command.withSubcommands([guard, prompt, stop, ready]),
  )

type Finding = { readonly mark: "ok" | "problem" | "note"; readonly text: string; readonly fix?: string }
const MARKS = { ok: "✓", problem: "✗", note: "·" } as const

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const sections: Array<{ readonly title: string; readonly findings: ReadonlyArray<Finding> }> = []
    const width = Math.max(...HARNESS_IDS.map((h) => h.length))

    const installs = yield* extraVibests
    if (installs.length > 0) sections.push({ title: "vibest on PATH", findings: installs })

    const daemon: Array<Finding> = []
    let ping = Option.getOrUndefined(yield* readPing(layout.socket))
    if (ping === undefined) {
      const started = yield* startDaemon.pipe(
        Effect.as(true),
        Effect.catch((e) => Effect.succeed(e.message)),
      )
      ping = Option.getOrUndefined(yield* readPing(layout.socket))
      if (ping === undefined)
        daemon.push({
          mark: "problem",
          text: `not running and did not start: ${started === true ? "no answer" : started}`,
          fix: `see ${layout.home}/vibestd.log`,
        })
      else daemon.push({ mark: "note", text: "was not running; started it" })
    }
    const talks = ping !== undefined && ping.protocol === PROTOCOL
    if (ping !== undefined && !talks)
      daemon.push({
        mark: "problem",
        text: `running ${ping.version}${ping.pid ? ` (pid ${ping.pid})` : ""}, a build this vibest ${VERSION} cannot talk to; runtimes and plugins are not checked`,
        fix: "vibest daemon restart",
      })
    else if (ping !== undefined) {
      daemon.push({ mark: "ok", text: `running ${ping.version}${ping.pid ? ` (pid ${ping.pid})` : ""}` })
      if (ping.version !== VERSION)
        daemon.push({ mark: "note", text: `this vibest is ${VERSION}; to run it instead: vibest daemon restart` })
    }
    sections.push({ title: "vibestd (the background service)", findings: daemon })

    const harnessNote = (why: string): Finding => ({ mark: "note", text: `not checked: vibestd ${why}` })
    let usable: Array<string> = []
    if (!talks) {
      sections.push({
        title: "Coding agents (the harnesses vibest starts)",
        findings: [harnessNote(ping === undefined ? "is not running" : `speaks protocol ${ping.protocol}`)],
      })
    } else {
      const listed = yield* RpcClient.withHeaders(
        connect(layout.socket).pipe(Effect.flatMap((c) => c["Harnesses.List"]())),
        protocolHeaders(),
      ).pipe(Effect.scoped, Effect.option)
      const harnesses: Array<Finding> = Option.isNone(listed)
        ? [harnessNote("did not answer")]
        : listed.value.map((row) =>
            row.problem
              ? { mark: "problem" as const, text: `${row.harness.padEnd(width)}  ${row.problem}` }
              : {
                  mark: "ok" as const,
                  text: `${row.harness.padEnd(width)}  ${row.models.length} models, default ${row.models.find((m) => m.default)?.model ?? "chosen by the harness"}`,
                },
          )
      if (Option.isSome(listed)) usable = listed.value.filter((row) => row.problem === null).map((row) => row.harness)
      sections.push({ title: "Coding agents (the harnesses vibest starts)", findings: harnesses })
    }

    if (talks) {
      const ask = <A, E>(f: (c: VibestClient) => Effect.Effect<A, E>) =>
        RpcClient.withHeaders(connect(layout.socket).pipe(Effect.flatMap(f)), protocolHeaders()).pipe(
          Effect.scoped,
          Effect.option,
        )
      const runtimes = yield* ask((c) => c["Runtimes.Doctor"]({ harnesses: usable }))
      if (Option.isNone(runtimes) || runtimes.value.length === 0)
        sections.push({
          title: "Runtimes (where agents run)",
          findings: [
            {
              mark: "problem",
              text: Option.isNone(runtimes)
                ? "vibestd did not list its runtimes"
                : "none loaded; agents have nowhere to run",
              fix: "vibest plugins",
            },
          ],
        })
      for (const r of Option.getOrElse(runtimes, () => [])) {
        const findings: Array<Finding> =
          r.status === "online" ? [] : [{ mark: "problem", text: `${r.status}: ${r.reason ?? "unknown"}` }]
        for (const c of r.checks)
          findings.push({
            mark: c.ok ? "ok" : "problem",
            text: c.subject ? `${c.subject.padEnd(width)}  ${c.text}` : c.text,
            ...(c.fix ? { fix: c.fix } : {}),
          })
        if (findings.length === 0) findings.push({ mark: "ok", text: "online" })
        sections.push({ title: `Runtime: ${r.name} (where agents run)`, findings })
      }
      const loaded = yield* ask((c) => c.Plugins())
      sections.push({
        title: "Plugins",
        findings: Option.match(loaded, {
          onNone: (): Array<Finding> => [{ mark: "note", text: "vibestd did not list its plugins" }],
          onSome: (all): Array<Finding> => [
            ...(all.some((p) => p.status === "active")
              ? [
                  {
                    mark: "ok" as const,
                    text: `active: ${all
                      .filter((p) => p.status === "active")
                      .map((p) => p.id)
                      .join(", ")}`,
                  },
                ]
              : []),
            ...all
              .filter((p) => p.status === "failed")
              .map((p): Finding => ({
                mark: "problem",
                text: `${p.id}: ${p.error ?? "failed"}`,
                fix: `fix or remove ${p.source}`,
              })),
          ],
        }),
      })
    }

    const lines = [`vibest ${VERSION}`]
    for (const section of sections) {
      lines.push("", section.title)
      for (const f of section.findings) {
        lines.push(`  ${MARKS[f.mark]} ${f.text}`)
        if (f.fix) lines.push(`      fix: ${f.fix}`)
      }
    }
    const problems = sections.flatMap((x) => x.findings).filter((f) => f.mark === "problem").length
    lines.push(
      "",
      problems === 0 ? "Ready." : `${problems} problem${problems === 1 ? "" : "s"}; run the fix lines above.`,
    )
    yield* Console.log(lines.join("\n"))
    yield* updateNotice
  }),
).pipe(
  Command.withDescription(
    "Check that vibest can work here: the coding agents, vibestd, each runtime agents run in, and plugins, each problem with how to fix it; starts vibestd when it is not running",
  ),
)

export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", { message: Schema.String }) {}

export const isSemver = (v: string) =>
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(v)

const RELEASES = "https://github.com/vibest-dev/vibest/releases/latest/download"

export const installMethod = (self: ReadonlyArray<string>, harnesses: string | undefined) => {
  if (harnesses) return { kind: "npm" } as const
  const m = self.length === 1 ? /^(.+)\/versions\/[^/]+\/bin\/vibest$/.exec(self[0]!) : null
  return m ? ({ kind: "curl", share: m[1]! } as const) : undefined
}

export const ownerOf = (real: string) => {
  if (real.includes("/.bun/install/global/node_modules/")) return { kind: "bun" } as const
  const npm = /^(.+)\/lib\/node_modules\/@vibest\//.exec(real)
  return npm ? ({ kind: "npm", prefix: npm[1]! } as const) : undefined
}

export const upgradeCommand = (real: string, version: string, platform = `${process.platform}-${process.arch}`) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? ["bun", "add", "-g", `@vibest/cli@${version}`, `@vibest/cli-${platform}@${version}`]
    : owner?.kind === "npm"
      ? [`${owner.prefix}/bin/npm`, "install", "-g", "--prefix", owner.prefix, `@vibest/cli@${version}`]
      : ["npm", "install", "-g", `@vibest/cli@${version}`]
}

export const stageCommand = (
  real: string,
  dir: string,
  version: string,
  platform = `${process.platform}-${process.arch}`,
) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? ["bun", "add", "--cwd", dir, `@vibest/cli@${version}`, `@vibest/cli-${platform}@${version}`]
    : [owner?.kind === "npm" ? `${owner.prefix}/bin/npm` : "npm", "install", "--prefix", dir, `@vibest/cli@${version}`]
}

export const removeCommand = (link: string, real: string) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? "bun remove -g @vibest/cli"
    : owner?.kind === "npm"
      ? `${shellQuote(`${owner.prefix}/bin/npm`)} uninstall -g --prefix ${shellQuote(owner.prefix)} @vibest/cli`
      : `rm ${shellQuote(link)}`
}

const extraVibests = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dirs = (Option.getOrUndefined(yield* Config.option(Config.String("PATH"))) ?? "").split(":").filter(Boolean)
  const found: Array<{ readonly link: string; readonly real: string }> = []
  for (const dir of dirs) {
    const link = `${dir}/vibest`
    const real = yield* fs.realPath(link).pipe(Effect.option)
    if (Option.isSome(real) && !found.some((f) => f.real === real.value)) found.push({ link, real: real.value })
  }
  if (found.length < 2) return []
  return yield* Effect.forEach(
    found,
    (v, i) =>
      Effect.map(versionOf([v.link]), (version): Finding =>
        i === 0
          ? { mark: "note", text: `${v.link} ${version} runs as vibest; ${found.length - 1} more on PATH` }
          : {
              mark: "problem",
              text: `${v.link} ${version} is also on PATH, behind the first`,
              fix: removeCommand(v.link, v.real),
            },
      ),
    { concurrency: "unbounded" },
  )
})

const latestVersion = (
  url: string,
  read: (body: HttpClientResponse.HttpClientResponse) => Effect.Effect<string, unknown>,
) =>
  HttpClient.get(url).pipe(
    Effect.filterOrFail(
      (r) => r.status !== 404,
      () => new Error(`no vibest release is published there yet; this vibest ${VERSION} stays as it is`),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(read),
    Effect.map((v) => v.trim()),
    Effect.filterOrFail(isSemver, (v) => new Error(`not a semver version: ${JSON.stringify(v)}`)),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new Error("no answer")) }),
    Effect.mapError(
      (e) => new UpdateError({ message: `could not read ${url}: ${e instanceof Error ? e.message : String(e)}` }),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

const npmLatest = Effect.gen(function* () {
  const registry = yield* Config.String("npm_config_registry").pipe(Config.withDefault("https://registry.npmjs.org"))
  return yield* latestVersion(`${registry.replace(/\/+$/, "")}/@vibest/cli/beta`, (r) =>
    Effect.map(HttpClientResponse.schemaBodyJson(Schema.Struct({ version: Schema.String }))(r), (b) => b.version),
  )
})

const UPDATE_CHECK_EVERY = Duration.hours(24)

const updateNotice = Effect.gen(function* () {
  if (Option.isSome(yield* Config.option(Config.String("VIBEST_AGENT")))) return
  if (Option.isSome(yield* Config.option(Config.String("VIBEST_NO_UPDATE_CHECK")))) return
  const method = installMethod(
    yield* VibestCommand,
    Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))),
  )
  if (!method) return
  const fs = yield* FileSystem.FileSystem
  const file = `${(yield* Layout).home}/update-check.json`
  const Cached = Schema.Struct({ checkedAt: Schema.Number, latest: Schema.NullOr(Schema.String) })
  const cached = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Cached))), Effect.option)
  const now = Date.now()
  let latest = Option.match(cached, { onNone: () => null, onSome: (c) => c.latest })
  if (Option.isNone(cached) || now - cached.value.checkedAt > Duration.toMillis(UPDATE_CHECK_EVERY)) {
    const releases = (yield* Config.String("VIBEST_DOWNLOAD_URL").pipe(Config.withDefault(RELEASES))).replace(
      /\/+$/,
      "",
    )
    const read = method.kind === "npm" ? npmLatest : latestVersion(`${releases}/version`, (r) => r.text)
    latest = yield* read.pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => latest),
    )
    yield* writeAtomic(file, JSON.stringify({ checkedAt: now, latest }))
  }
  if (latest !== null && compareVersions(VERSION, latest) < 0)
    yield* Console.error(`vibest ${latest} is available (this is ${VERSION}); update with: vibest update`)
}).pipe(Effect.ignore)

const runInherit = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(argv[0]!, argv.slice(1), {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env,
          extendEnv: true,
        }),
      )
      .pipe(Effect.mapError((e) => new UpdateError({ message: `${argv.join(" ")}: ${e.message}` })))
    if (code !== 0) return yield* new UpdateError({ message: `${argv.join(" ")} exited with ${code}` })
  })

const LEFT: Record<ReplaceFailed["outcome"], string> = {
  declined: "vibestd not replaced: you declined; it still runs the vibest it was started with",
  busy: "vibestd not replaced: it refused to stop (see above); it still runs the vibest it was started with",
  unchanged: "vibestd not replaced: it still runs the vibest it was started with",
  unknown: "vibestd was asked to stop; whether it, the new one or none runs now is not known (see vibest status)",
  other: "vibestd was asked to stop, and another vibestd answers now, not the vibest asked for",
}

const replaceForUpdate = (target: { readonly version: string; readonly command: ReadonlyArray<string> }) =>
  replaceDaemon(target).pipe(
    Effect.as(undefined),
    Effect.catchTag("ReplaceFailed", (e) =>
      e.outcome === "declined"
        ? Console.log(`${LEFT.declined}. To replace it later: vibest daemon restart`).pipe(Effect.as(undefined))
        : Console.error(`${LEFT[e.outcome]}. ${e.message}`).pipe(Effect.as(LEFT[e.outcome])),
    ),
  )

export const daemonPlan = (
  ping: Ping | undefined,
  target: { readonly version: string; readonly command: ReadonlyArray<string> },
) =>
  ping === undefined
    ? ({ action: "none", reason: "vibestd is not running; the next vibest command starts the new version" } as const)
    : ping.protocol === PROTOCOL &&
        ping.version === target.version &&
        ping.command?.join("\0") === target.command.join("\0")
      ? ({ action: "keep", reason: `vibestd ${ping.version} already runs this vibest` } as const)
      : ping.capabilities?.handoff === true
        ? ({
            action: "handoff",
            reason: `vibestd ${ping.version} hands itself over to ${target.version} (agents keep running)`,
          } as const)
        : ({
            action: "restart",
            reason: `vibestd ${ping.version} cannot hand itself over, so it is stopped and ${target.version} started`,
          } as const)

const HANDOFF_WATCH = Duration.seconds(45)

const handoffDaemon = (old: Ping, target: { readonly version: string; readonly command: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const reported = yield* versionOf(target.command)
    if (reported !== target.version)
      return `\`${target.command.join(" ")} --version\` reports ${reported}, not ${target.version}; the old vibestd still runs. Next: vibest update`
    const reply = yield* RpcClient.withHeaders(
      connect(layout.socket).pipe(
        Effect.flatMap((c) => c["Daemon.Handoff"]({ instance: old.instance!, command: target.command })),
      ),
      cliHeaders((yield* Path.Path).resolve(".")),
    ).pipe(Effect.scoped, Effect.exit)
    if (Exit.isFailure(reply)) {
      const e = Option.getOrUndefined(Cause.findErrorOption(reply.cause)) as { readonly message?: string } | undefined
      const still = Option.getOrUndefined(yield* readPing(layout.socket))
      if (still?.instance === old.instance)
        return `the handoff did not happen (${e?.message ?? "no reply"}); the old vibestd ${old.version} still runs. Next: vibest update`
    }
    const now = yield* readPing(layout.socket).pipe(
      Effect.repeat({
        until: (p) => Option.isSome(p) && p.value.instance !== old.instance && p.value.version === target.version,
        schedule: Schedule.spaced("200 millis"),
      }),
      Effect.timeoutOption(HANDOFF_WATCH),
      Effect.map(Option.flatten),
    )
    if (Option.isSome(now)) {
      yield* Console.log(`vibestd ${now.value.version} (pid ${now.value.pid}) took over; agents kept running.`)
      return undefined
    }
    const after = Option.getOrUndefined(yield* readPing(layout.socket))
    if (after === undefined)
      return `no vibestd answers on ${layout.socket}. Next: vibest daemon (see ${layout.home}/vibestd.log)`
    return `vibestd ${after.version} (instance ${after.instance ?? "unknown"}) answers, not the new ${target.version}. Next: vibest update`
  })

const restartAgents = (version: string, yes: boolean, command: "vibest update" | "vibest daemon restart") =>
  Effect.gen(function* () {
    const cwd = (yield* Path.Path).resolve(".")
    const ask = <A, E>(f: (client: VibestClient) => Effect.Effect<A, E>) =>
      withVibest({ _tag: "cli", repositoryRoot: cwd }, f, { start: false })
    const outdated = yield* ask((client) => client["Agents.Outdated"]())
    if (outdated.length === 0) return yield* Console.log("No agent runs an old integration.")
    const working = outdated.filter((a) => a.working).map((a) => shortId(a.id))
    const ids = outdated.map((a) => shortId(a.id)).join(", ")
    const busy = working.length === 0 ? "" : `; ${working.join(", ")} ${working.length === 1 ? "is" : "are"} working`
    const blocked = outdated.filter((a) => a.blocked !== null)
    const restartable = outdated.filter((a) => a.blocked === null)
    const refused = "their calls to vibestd will be refused with a message that names vibest update"
    const lead = command === "vibest update" ? `vibest ${version} installed.` : `vibestd ${version} runs now.`
    const list = `${outdated.length} agent${outdated.length === 1 ? "" : "s"} still run${outdated.length === 1 ? "s" : ""} the old integration (${ids}${busy})`
    for (const a of blocked) yield* Console.log(`${shortId(a.id)} cannot be restarted in place: ${a.blocked}.`)
    if (restartable.length === 0) return
    if (!yes) {
      if (!(yield* interactive))
        return yield* Console.log(
          `${lead} ${list}. Not restarted without a terminal (${command === "vibest update" ? "vibest update --yes" : "vibest daemon restart in a terminal"} restarts them); ${refused} until then.`,
        )
      if (
        !(yield* askYesNo(
          `${lead} ${list}. Restart ${restartable.length === 1 ? "it" : `these ${restartable.length} agents`} in place and continue ${restartable.length === 1 ? "its conversation" : "their conversations"}? [Y/n]: `,
          "2 minutes",
          true,
        ))
      )
        return yield* Console.log(`They keep the old integration; ${refused}.`)
    }
    yield* ask((client) => client["Agents.Restart"]({ ids: restartable.map((a) => a.id), after: process.pid }))
    yield* Console.log(
      `${command} has finished. vibestd restarts ${restartable.map((a) => shortId(a.id)).join(", ")} in place once this command has exited, main agents last; one that was working continues its turn (outcomes in ${(yield* Layout).home}/vibestd.log).`,
    )
  })

const update = Command.make(
  "update",
  {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription(
        "Restart the agents still on the old integration without asking (a shell without a terminal, such as the main agent's)",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ yes }) =>
    Effect.gen(function* () {
      const isMainAgent =
        Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT"))) === Guard.COORDINATOR
      if (!isMainAgent) yield* userOnly("update")
      const self = yield* VibestCommand
      const method = installMethod(self, Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))))
      const layout = yield* Layout
      let target: { readonly version: string; readonly command: ReadonlyArray<string> } = {
        version: VERSION,
        command: self,
      }
      let back: string | undefined
      if (method === undefined)
        yield* Console.log(
          `this vibest (${self.join(" ")}) was not installed by npm or install.sh; nothing to install.`,
        )
      else {
        const releases = (yield* Config.String("VIBEST_DOWNLOAD_URL").pipe(Config.withDefault(RELEASES))).replace(
          /\/+$/,
          "",
        )
        const latest = yield* method.kind === "npm" ? npmLatest : latestVersion(`${releases}/version`, (r) => r.text)
        if (compareVersions(VERSION, latest) >= 0) yield* Console.log(`vibest is already up to date (v${VERSION}).`)
        else {
          yield* Console.log(`vibest ${latest} is available (this is ${VERSION}).`)
          const fs = yield* FileSystem.FileSystem
          const real = yield* fs.realPath(self[0]!).pipe(Effect.orElseSucceed(() => self[0]!))
          const installSh = (env: Record<string, string>) =>
            [
              ["sh", "-c", 'script=$(curl -fsSL "$0/install.sh") && printf \'%s\\n\' "$script" | sh', releases],
              { VIBEST_DOWNLOAD_URL: releases, ...env },
            ] as const
          const cannot = yield* Effect.scoped(
            Effect.gen(function* () {
              const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-update-" })
              const [argv, env] =
                method.kind === "npm"
                  ? [stageCommand(real, dir, latest), {}]
                  : installSh({ VIBEST_INSTALL: `${dir}/share`, VIBEST_BIN: `${dir}/bin` })
              const staged = [method.kind === "npm" ? `${dir}/node_modules/.bin/vibest` : `${dir}/bin/vibest`]
              const fetched = yield* runCaptured(argv, Duration.minutes(5), env)
              if (fetched !== undefined)
                return `it could not be fetched to try it first (${argv.join(" ")}: ${fetched})`
              const reported = yield* versionOf(staged)
              if (reported !== latest) return `the vibest fetched to try it reports ${reported}, not ${latest}`
              return yield* importCheck(staged)
            }),
          )
          if (cannot !== undefined) {
            const running = Option.getOrUndefined(yield* readPing(layout.socket))
            const kept = running
              ? `${described(running.version, running)} was not stopped and keeps working`
              : "no vibestd was running, and none was started"
            return yield* new UpdateError({
              message: `vibest ${latest} cannot take over: ${cannot}. Nothing was installed: vibest ${VERSION} stays, and ${kept}. ${running && /SchemaMismatch/.test(cannot) ? replaceAnyway(layout.socket, running.pid, "vibest update") : "Once that is fixed, run vibest update again"}`,
            })
          }
          const [installArgv, installEnv] =
            method.kind === "npm" ? [upgradeCommand(real, latest), {}] : installSh({ VIBEST_INSTALL: method.share })
          yield* runInherit(installArgv, installEnv).pipe(
            Effect.mapError((e) => new UpdateError({ message: `${e.message}; vibestd not attempted` })),
          )
          target = {
            version: latest,
            command: method.kind === "curl" ? [`${method.share}/versions/${latest}/bin/vibest`] : self,
          }
          back =
            method.kind === "npm"
              ? upgradeCommand(real, VERSION).map(shellQuote).join(" ")
              : `ln -sfn ${shellQuote(self[0]!)} "$(cat ${shellQuote(`${method.share}/bin`)} 2>/dev/null || echo ~/.local/bin)/vibest"`
        }
      }
      for (const f of yield* extraVibests)
        yield* Console.log(
          `${f.mark === "problem" ? "warning: " : ""}${f.text}${f.fix ? `; remove it with: ${f.fix}` : ""}`,
        )
      const running = Option.getOrUndefined(yield* readPing(layout.socket))
      const plan = daemonPlan(running, target)
      if (plan.action === "none") return
      yield* Console.log(`vibestd: ${plan.action}. ${plan.reason}.`)
      const failed =
        plan.action === "handoff"
          ? yield* handoffDaemon(running!, target)
          : plan.action === "restart"
            ? yield* replaceForUpdate(target)
            : undefined
      if (failed !== undefined)
        return yield* new UpdateError({
          message: `vibest ${target.version}: ${failed}${back === undefined ? "" : `. To go back to vibest ${VERSION} instead: ${back}`}`,
        })
      const agents = yield* restartAgents(target.version, yes, "vibest update")
      if (agents !== undefined) return yield* new UpdateError({ message: agents })
    }),
).pipe(
  Command.withAlias("upgrade"),
  Command.withDescription(
    "Update vibest the way it was installed (install.sh: the latest GitHub release; npm: the version the registry's beta tag names, at that exact version, with the package manager that installed it; either is first tried aside and must open the database), hand the running vibestd over to it (agents keep running), then offer to restart the agents still on the old integration in place, with their conversations",
  ),
)

export const command = (host: Daemon.Host, exec: Exec) =>
  Command.make("vibest", mainFlags, startMain(exec, host)).pipe(
    Command.withDescription(
      "vibest: in a project directory, open its main agent here (--new: a new conversation); the main agent runs subagents in herdr panes",
    ),
    Command.withSubcommands([
      daemon(host),
      run,
      send,
      status,
      result,
      interrupt,
      peek,
      archive,
      ls,
      report,
      models,
      harness,
      project,
      plugins,
      subscriptions,
      integration(),
      doctor,
      update,
      herdrCommands(userOnly),
    ]),
  )

export const printFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.findErrorOption(cause)
      if (Option.isNone(error)) return Console.error(Cause.pretty(cause))
      const e: unknown = error.value
      if (CliError.isCliError(e)) return Effect.void
      if (typeof e !== "object" || e === null || !("_tag" in e)) return Console.error(String(e))
      const { _tag, message } = e as { readonly _tag: string; readonly message?: string }
      return Console.error(message ? `${_tag}: ${message}` : _tag)
    }),
  )

export const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const error = Cause.findErrorOption(exit.cause)
  onExit(Option.isSome(error) && CliError.isCliError(error.value) ? 2 : 1)
}
