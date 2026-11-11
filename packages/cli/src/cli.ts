import { commands } from "@vibest/builtins"
import {
  awaitDaemon,
  claimHeaders,
  hookCall,
  type VibestClient,
  probe,
  readPing,
  startDaemon,
  withVibest,
} from "@vibest/client/client"
import type { LayerNode } from "@vibest/core/effect/layer-node"
import { askLine, askYesNo, interactive, Layout, VibestCommand } from "@vibest/core/paths"
import { messageOf } from "@vibest/core/plugin-sources"
import { describeSpawn } from "@vibest/core/plugins"
import { ProjectKind } from "@vibest/core/project"
import { LaunchFailed } from "@vibest/core/sessions"
import { UpdateError } from "@vibest/core/update-check"
import { type Ping, VERSION } from "@vibest/protocol/rpc"
import { HarnessUnavailable } from "@vibest/schema/session"
import * as Daemon from "@vibest/server/daemon"
import {
  Cause,
  Clock,
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  type Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClientError as ClientError } from "effect/rpc"

import { caller, json, userOnly, vibest } from "./caller.ts"
import { doctor } from "./doctor.ts"
import { connectCommand, machine, projectAdd } from "./machine-commands.ts"
import { replaceDaemon } from "./replace.ts"
import { LEFT, noticeFrom, restartAgents, update, updateNotice } from "./update.ts"

export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

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

const daemon = (host: Daemon.Host, replacements: LayerNode.Replacements) =>
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
              return yield* Daemon.run(host, replacements, { handoff })
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
    words: Argument.String("harness and prompt").pipe(
      Argument.between(1, 2),
      Argument.withMetavar("[<harness>] <prompt>"),
      Argument.withDescription(
        "The harness (leave it out to use the caller's harness, provider and model: yours, or the main agent's from a plain terminal; name one to switch), then the prompt: literal text, or - to read it from stdin. Put -- before the prompt so text starting with - is not read as an option",
      ),
    ),
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
        "A session id (or a unique prefix of at least 8 characters): run in its directory, on its runtime and machine, in a pane split from its pane, instead of a new worktree (the directory goes with the archive of the last live session in it)",
      ),
      Flag.optional,
    ),
    archive: Flag.Boolean("archive-on-idle").pipe(
      Flag.withDescription(
        "Archive the session the first time it is idle after a completed execution with nothing it sent or was sent still waiting (as vibest archive: branch kept, worktree removed only when git loses nothing)",
      ),
      Flag.withDefault(false),
    ),
    runtime: Flag.String("runtime").pipe(
      Flag.withDescription(
        "The terminal runtime for this session. Default: the --peer session's, otherwise its parent's",
      ),
      Flag.optional,
    ),
    machine: Flag.String("machine").pipe(
      Flag.withDescription(
        "Run it on another machine (vibest machine ls), in that machine's checkout of this repository at this HEAD; its address is <machine>/<id>, and its results come to this project's main agent, or stay there for vibest result <machine>/<id> when there is none",
      ),
      Flag.optional,
    ),
    session: sessionFlag,
  },
  (o) =>
    Effect.gen(function* () {
      const [harness, raw] = o.words.length === 2 ? o.words : [undefined, o.words[0]!]
      const prompt = yield* input(raw, "prompt")
      const spawned = yield* requested((client, request, ping) =>
        Effect.gen(function* () {
          if (Option.isSome(o.runtime) && ping.capabilities?.spawnRuntime !== true)
            return yield* new LaunchFailed({
              message: "this vibestd does not take --runtime on vibest run; run vibest update",
            })
          if (
            harness === undefined &&
            /^\S+$/.test(prompt) &&
            (yield* client["Harnesses.List"]({})).some((choice) => choice.harness === prompt)
          )
            return yield* new EmptyInput({
              message: `the prompt is missing: ${prompt} is a harness; give the prompt after it`,
            })
          return yield* client.Spawn({
            ...(request === undefined ? {} : { request }),
            harness,
            prompt,
            name: Option.getOrUndefined(o.title),
            provider: Option.getOrUndefined(o.provider),
            model: Option.getOrUndefined(o.model),
            env: Option.getOrUndefined(o.env),
            peer: Option.getOrUndefined(o.peer),
            archive: o.archive || undefined,
            runtime: Option.getOrUndefined(o.runtime),
            machine: Option.getOrUndefined(o.machine),
            callerEnv: callerEnvOf(),
            ...(Option.isNone(o.session) ? {} : { runtimeSession: o.session.value }),
          })
        }),
      )
      yield* json({ id: spawned.id })
    }),
).pipe(
  Command.withDescription(
    'Start a session on a task and print {"id":"<session id>"} at once; the routing that plugins decided is in the routing field of vibest ls and vibest result. An execution end sends nothing: the session sends a message with vibest send when it decides to, and its latest reply is read with vibest result. vibest makes each session its own worktree (detached, no branch); in a project of several repositories (a directory of git repositories) that is one worktree of every repository, side by side. The main agent may run it from anywhere in its project, also from inside one repository. Never tell the session to make its own worktree, clone or copy',
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
  harness: Flag.String("harness").pipe(
    Flag.withDescription("Leave out for the harness the main agent last used; a project's first start needs it"),
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
}

const callerEnvOf = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const startMain =
  (exec: Exec) =>
  (o: {
    readonly fresh: boolean
    readonly harness: Option.Option<string>
    readonly provider: Option.Option<string>
    readonly model: Option.Option<string>
    readonly session: Option.Option<string>
    readonly headless: boolean
    readonly runtime: Option.Option<string>
  }) =>
    Effect.gen(function* () {
      yield* userOnly("")
      yield* updateNotice
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
      yield* withVibest(claim, openProject)
      const placed = yield* withVibest(claim, (client) =>
        client["Project.MainPlace"]({
          callerEnv: callerEnvOf(),
          ...(runtimeKind === undefined ? {} : { runtime: runtimeKind }),
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
        if (opened.routing !== undefined) yield* Console.error(`main agent: ${opened.routing}`)
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
    "Continue a session: queue a message, delivered once it is idle (never interrupts an execution); prints at once",
  ),
)

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const info = yield* Daemon.readDaemonInfo(layout.daemonInfo)
    const ping = yield* readPing(layout.socket)
    yield* noticeFrom(Effect.succeed(ping))
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
          update: p.update ?? null,
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
    "Interrupt a session's running execution; the session stays for follow-ups (no reply arrives for that execution)",
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
      Effect.flatMap((r) =>
        Effect.gen(function* () {
          if (r.terminal !== undefined) yield* Console.error(`terminal here: ${r.terminal.split("@")[0]}`)
          if (r.view !== undefined) yield* Console.error(`not shown here: ${r.view}`)
          yield* Console.log(r.text)
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Print the last lines on a session's terminal, read now (plain text). Results never carry screen text: look here when one says the execution ended without a reply or did not start",
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
    "Archive an agent session (a working one is interrupted for up to 10 s, then its pane closed and that execution's reply lost; releases terminal pane, workspace, and clean worktree; retains the session row, inbox history, and stored replies)",
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
        Effect.map((listed) => ({ ...listed, sessions: listed.sessions.map(titled) })),
        Effect.flatMap(json),
      )
    }),
).pipe(
  Command.withDescription(
    "Your sessions that have not exited, as JSON: each task (cut to 500 characters), its live status, and its latest result (--all: exited ones too). vibest result keeps the full task",
  ),
)

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Only this provider's models; a harness with no provider option refuses it"),
  Flag.optional,
)
const catalog = (provider?: string) =>
  Effect.flatMap(caller, (c) =>
    withVibest(c.claim, (client) => client["Harnesses.List"]({ provider }), { start: !c.agent }),
  )
const modelsOf = (harness: string | undefined, provider: Option.Option<string>) =>
  Effect.gen(function* () {
    const all = yield* catalog(Option.getOrUndefined(provider))
    const choices = harness === undefined ? all : all.filter((c) => c.harness === harness)
    if (harness !== undefined && choices.length === 0)
      return yield* new HarnessUnavailable({
        harness,
        message: `no plugin provides harness ${harness}; loaded: ${all.map((c) => c.harness).join(", ") || "none"}`,
      })
    const models = choices.flatMap((c) =>
      c.problem === null ? c.models.map((m) => ({ harness: c.harness, ...m })) : [],
    )
    const errors = choices.flatMap((c) =>
      c.problem !== null
        ? [`${c.harness}: ${c.problem}`]
        : c.models.length === 0
          ? [`${c.harness}: ${c.binary} lists no models for provider "${Option.getOrNull(provider)}"`]
          : [],
    )
    yield* json({ models, errors })
  })

const models = Command.make(
  "models",
  {
    target: Argument.String("harness").pipe(Argument.withDescription("Only this harness's models"), Argument.optional),
    harness: Flag.String("harness").pipe(Flag.withDescription("Same as the harness argument"), Flag.optional),
    provider: providerFlag,
  },
  (o) => modelsOf(Option.getOrUndefined(Option.orElse(o.target, () => o.harness)), o.provider),
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
        const choices = yield* catalog()
        yield* json(
          choices.map((c) => ({
            harness: c.harness,
            binary: c.binary,
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
    Command.make("models", { harness: Argument.String("harness"), provider: providerFlag }, (o) =>
      modelsOf(o.harness, o.provider),
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
    projectAdd(openProject),
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

const notify = <A>(
  harness: string,
  sessionId: string,
  what: string,
  send: (client: VibestClient) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const headers = yield* claimHeaders({ _tag: "session", sessionId })
    const exit = yield* hookCall(layout.socket, headers, send)
    if (Exit.isSuccess(exit)) return exit.value
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    const cause = Cause.squash(exit.cause)
    return yield* Effect.fail(
      `${at} vibest: ${harness} ${what} of session ${sessionId} did not reach vibestd: ${messageOf(cause)}`,
    )
  })

const hookSession = Effect.gen(function* () {
  const agent = yield* nonempty("VIBEST_AGENT")
  const sessionId = yield* nonempty("VIBEST_SESSION_ID")
  return agent && sessionId ? { agent, sessionId } : undefined
})

export const integrationStop = (harness: string, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "execution end", (client) =>
      client.ExecutionEnd({ sessionId: who.sessionId, harness, event: raw }),
    )
  })

export const integrationPrompt = (harness: string, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "execution start", (client) =>
      client.Prompt({ sessionId: who.sessionId, harness, event: raw }),
    )
  })

export const integrationReady = (harness: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "ready report", (client) => client["Session.Ready"]({ id: who.sessionId }))
  })

const hookHarness = Flag.String("harness").pipe(Flag.withDescription("The harness whose hook this is"))

const hookCommand = <E, R>(
  name: string,
  report: (harness: string, raw: string) => Effect.Effect<void, E, R>,
  description: string,
) =>
  Command.make(name, { harness: hookHarness }, (o) =>
    Effect.gen(function* () {
      yield* report(o.harness, yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)))
    }),
  ).pipe(Command.withDescription(description))

const stop = hookCommand(
  "stop",
  integrationStop,
  "A harness plugin's execution-end bridge: its execution-end event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const prompt = hookCommand(
  "prompt",
  integrationPrompt,
  "A harness plugin's execution-start bridge: its prompt or activity event JSON on stdin. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const ready = hookCommand(
  "ready",
  integrationReady,
  "A harness plugin's session-start bridge: tells vibestd the session takes input. Does not start vibestd; exits non-zero when the report did not reach vibestd",
)

const guard = Command.make("guard", { harness: hookHarness }, (o) =>
  Effect.gen(function* () {
    const agent = yield* Config.String("VIBEST_AGENT")
    const sessionId = yield* Config.String("VIBEST_SESSION_ID")
    const input = yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin))
    const { answer } = yield* notify(o.harness, sessionId, "guard", (client) =>
      client["Integration.Guard"]({ harness: o.harness, agent, input }),
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
      "Internal: called by vibest's plugin in each harness (user prompt, execution end, pre-tool guard); not for direct use",
    ),
    Command.withSubcommands([guard, prompt, stop, ready]),
  )

export const command = (host: Daemon.Host, replacements: LayerNode.Replacements, exec: Exec) =>
  Command.make("vibest", mainFlags, startMain(exec)).pipe(
    Command.withDescription(
      "vibest: in a project directory, open its main agent here (--new: a new conversation); the main agent runs subagents in herdr panes",
    ),
    Command.withSubcommands([
      daemon(host, replacements),
      run,
      send,
      status,
      result,
      interrupt,
      peek,
      archive,
      ls,
      models,
      harness,
      project,
      plugins,
      subscriptions,
      integration(),
      doctor,
      update,
      ...commands(userOnly),
      connectCommand,
      machine,
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
