import {
  type Claim,
  claimHeaders,
  cliHeaders,
  connect,
  hookCall,
  type VibestClient,
  probe,
  protocolHeaders,
  readPing,
  startDaemon,
  withVibest,
} from "@vibest/client/client"
import * as Guard from "@vibest/core/guard"
import { Harness, type HarnessAdapter, Harnesses, HARNESS_IDS, type HarnessId, preflight } from "@vibest/core/harness"
import * as Launch from "@vibest/core/launch"
import { listAllModels } from "@vibest/core/models"
import { askLine, askYesNo, interactive, Layout, shellQuote, VibestCommand, writeAtomic } from "@vibest/core/paths"
import { describeSpawn } from "@vibest/core/plugins"
import { ProjectKind } from "@vibest/core/project"
import { createProject, projectRoot } from "@vibest/core/project-create"
import { jsonObject, promptOf, writeTerminalStatus } from "@vibest/core/results"
// `vibest` command line (SPEC §12.1): one-shot calls, the only way agents use vibest. Who calls comes from the environment:
// VIBEST_SESSION_ID set means an agent (a coordinator or a session); unset, the command line (cli).
// That is a claim any same-user process can make, so vibestd's checks stop mistakes, not attackers (SPEC §13).
// Agent commands print one JSON document on stdout; errors are one `Tag: message` line on stderr and exit 1.
// Nothing waits for a session: results reach the coordinator by themselves, `vibest result` shows the latest one.
import { CALLER_ENV, ambientHerdr, callerMachine, callerTerminal } from "@vibest/runtime-herdr/caller"
import { shortId } from "@vibest/schema/id"
import * as Daemon from "@vibest/server/daemon"
import {
  Cause,
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
import { RpcClient } from "effect/rpc"

import { herdrCommands } from "./herdr-plugin.ts"
import { type ReplaceFailed, replaceDaemon, compareVersions, versionOf } from "./replace.ts"
export { compareVersions }
import { LaunchFailed } from "@vibest/core/sessions"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { Forbidden, type Ping, VERSION } from "@vibest/protocol/rpc"

/** A prompt, message or entry that is empty or only whitespace. */
export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

/** Who runs this command. `agent`: VIBEST_SESSION_ID is set, which never starts vibestd (it may run inside a sandbox). */
const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const agentName = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
  // A coordinator's shell sends its working directory as cwd, not as identity. A session does not: the server rejects it.
  const claim: Claim = sessionId
    ? { _tag: "session", sessionId, ...(agentName === "coordinator" ? { repositoryRoot } : {}) }
    : { _tag: "cli", repositoryRoot }
  return { claim, agent: sessionId !== undefined }
})

/**
 * vibestd and coordinators are started by the user: an agent's would run inside its sandbox. Updates change the user's
 * own setup. Checked before anything else; the pre-tool guard leaves these commands to it.
 */
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

/** Run `f` on a connection as the caller. Herdr location is a payload on the methods that need it, not connection state. */
const vibest = <A, E, R>(f: (client: VibestClient, agent: boolean) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(caller, (c) => withVibest(c.claim, (client) => f(client, c.agent), { start: !c.agent }))

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const json = (value: unknown) => Console.log(encodeJson(value))

/** Literal text, or `-` for stdin up to EOF. Never expanded: no `@file`, no variables. Empty text is refused. */
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
      // The new vibestd of a handoff, started by the old one (Daemon.Handoff): it waits for the old one's lock.
      handoff: Flag.Boolean("import").pipe(Flag.withHidden, Flag.withDefault(false)),
    },
    ({ foreground, handoff }) =>
      userOnly("daemon").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (foreground) {
              // The previous vibestd's in-memory main agent --env values: read once, then gone from this process's
              // environment, so nothing this vibestd starts inherits them.
              const raw = process.env[Daemon.HANDOFF_ENV]
              delete process.env[Daemon.HANDOFF_ENV]
              const mainEnv: Daemon.MainEnv | undefined = handoff && raw ? new Map(JSON.parse(raw)) : undefined
              return yield* Daemon.run(host, { handoff, ...(mainEnv ? { mainEnv } : {}) })
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
          // A no on the terminal is the user's answer, not a failure; anything else that leaves vibestd as it was fails.
          Effect.andThen(Effect.flatMap(VibestCommand, (command) => replaceDaemon({ version: VERSION, command }))),
          // The agents still on another integration than this vibestd's, asked about once, as `vibest update` does.
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
      // Internal: whether this vibest can open the running vibestd's database (Daemon.Handoff runs it first).
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
    session: sessionFlag,
  },
  (o) =>
    Effect.gen(function* () {
      const prompt = yield* input(o.prompt, "prompt")
      const machine = yield* callerMachine(Option.getOrUndefined(o.session))
      const spawned = yield* vibest((client) =>
        client.Spawn({
          harness: o.harness === "auto" ? undefined : o.harness,
          prompt,
          name: Option.getOrUndefined(o.title),
          provider: Option.getOrUndefined(o.provider),
          model: Option.getOrUndefined(o.model),
          env: Option.getOrUndefined(o.env),
          peer: Option.getOrUndefined(o.peer),
          archive: o.archive || undefined,
          machine,
        }),
      )
      yield* json(spawned)
    }),
).pipe(
  Command.withDescription(
    "Start a session on a task and print its id at once. The coordinator gets the result as a message when the session's turn ends; anyone else reads it with vibest result. vibest makes each session its own worktree (detached, no branch); in a project of several repositories (a directory of git repositories) that is one worktree of every repository, side by side. The main agent may run it from anywhere in its project, also from inside one repository. Never tell the session to make its own worktree, clone or copy",
  ),
)

/**
 * One main agent per project: `start` runs when no other terminal runs the project's main agent, or once the user
 * answered y and vibestd stopped that one's harness (its terminal and shell stay; `start` then resumes the same
 * conversation here, or a new one for another harness). A no, no answer within two minutes, EOF, a non-interactive
 * terminal, or a stop that did not finish starts nothing and changes nothing (vibestd's `Project.CoordinatorSession`
 * refuses a second one too).
 */
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

/**
 * `vibest` in the user's shell, before anything starts: the directory's project (`Project.Open`). A checkout that moved
 * is asked about: y or Enter moves the project here, n makes a new one; anything else, no answer, EOF or a
 * non-interactive terminal starts nothing and changes nothing.
 */
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

/** Replaces this process (from #platform). */
export type Exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => void

/** `vibest [--new] [--harness <h>]`: the flags of the command line's own command, which opens the project's main agent. */
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
  env: Flag.KeyValuePair("env").pipe(
    Flag.withDescription(
      "KEY=VALUE for the main agent's harness, never stored: vibestd keeps it in memory for a restart in place (vibest update); a vibestd stop or a new terminal loses it; run vibest --env again then",
    ),
    Flag.optional,
  ),
  session: sessionFlag,
  headless: Flag.Boolean("headless").pipe(
    Flag.withDescription("Outside herdr: do not attach to the session"),
    Flag.withDefault(false),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      "The terminal runtime the main agent runs in (a kind from `vibest status`; default: the choice plugin's)",
    ),
    Flag.optional,
  ),
  // Typed by Launch into the shell it opened in the repository's parent workspace: run in place without asking herdr,
  // which does not report a just-created workspace as the parent (asking would open another one, without end).
  inParent: Flag.String("in-parent").pipe(Flag.withHidden, Flag.optional),
}

/**
 * The project's main agent, here (architecture.md D4): scheduling and `agent.start` in vibestd choose its harness,
 * provider and model; this command only places it. In the repository's parent workspace this pane becomes the main
 * Agent; below the root its shell runs `vibest` again from the root; elsewhere a tab in the parent workspace does.
 */
const startMain =
  (exec: Exec) =>
  (o: {
    readonly fresh: boolean
    readonly harness: Option.Option<HarnessId>
    readonly provider: Option.Option<string>
    readonly model: Option.Option<string>
    readonly env: Option.Option<Record<string, string>>
    readonly session: Option.Option<string>
    readonly headless: boolean
    readonly runtime: Option.Option<string>
    readonly inParent: Option.Option<string>
  }) =>
    Effect.gen(function* () {
      yield* userOnly("")
      // Once, in the user's shell: the run again at the root (--in-parent) is the same command.
      if (Option.isNone(o.inParent)) yield* updateNotice
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const cwd = path.resolve(".")
      // A linked worktree starts at its main checkout. A directory of repositories is itself the Project.
      const { root } = yield* projectRoot(cwd)
      // The first run, in the user's shell: a checkout that moved is moved (or a new project made) before anything starts.
      if (Option.isNone(o.inParent)) yield* withVibest((yield* caller).claim, openProject)
      const harness = Option.getOrUndefined(o.harness)
      const provider = Option.getOrUndefined(o.provider)
      const model = Option.getOrUndefined(o.model)
      const runtimeKind = Option.getOrUndefined(o.runtime)
      const env = Option.getOrElse(o.env, (): Record<string, string> => ({}))
      /** This command again, run at the root. */
      const again = [
        ...(yield* VibestCommand),
        ...(harness ? ["--harness", harness] : []),
        ...(provider ? ["--provider", provider] : []),
        ...(model ? ["--model", model] : []),
        ...(runtimeKind ? ["--runtime", runtimeKind] : []),
        ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ...(o.fresh ? ["--new"] : []),
      ]
      // The command Launch typed says which repository's parent workspace it is in; the flag spares herdr the question.
      const marked = Option.contains(o.inParent, root)
      const here = marked ? undefined : yield* ambientHerdr
      const machine = yield* callerMachine(Option.getOrUndefined(o.session))
      // Inside herdr the main agent starts in this pane, wherever it is. Outside herdr it needs a herdr pane: one is opened.
      const inPlace = marked || here !== undefined
      if (inPlace) {
        // This pane is the main agent's, in the ambient herdr session; --session names another session whose panes that session cannot see.
        if (Option.isSome(o.session))
          return yield* new LaunchFailed({
            message: `--session ${o.session.value} names a herdr session; inside herdr this pane's own session is used. Run vibest outside herdr, or drop --session`,
          })
        // Below the root, continue in this process. Typing `cd && vibest --env` would put the values in the shell history.
        if ((yield* fs.realPath(cwd)) !== root) yield* Effect.sync(() => process.chdir(root))
        const terminal = yield* callerTerminal
        if (terminal === undefined)
          return yield* new LaunchFailed({
            message: "this pane's herdr session could not be named; run vibest outside herdr",
          })
        // The main agent's own `vibest` commands never start vibestd (they may run in its harness's sandbox): start it here.
        if (!(yield* probe((yield* Layout).socket))) yield* startDaemon
        const claim = (yield* caller).claim
        const chosen = yield* withVibest(claim, (client) =>
          client["Project.StartMain"]({ harness, provider, model, runtime: runtimeKind }),
        )
        if (Object.keys(chosen.decidedBy).length > 0) yield* Console.error(`main agent: ${describeSpawn(chosen)}`)
        // Only the start that execs asks vibestd for the session, so `--new` replaces it once.
        // Flags, or the pane's VIBEST_MAIN_ENV when this command was typed without --env.
        const passed = Object.keys(env).length > 0 ? env : Launch.mainEnvPairs(process.env[Launch.MAIN_ENV])
        const session = withVibest(claim, (client) =>
          Effect.gen(function* () {
            return yield* soleMainAgent(
              client,
              terminal,
              client["Project.CoordinatorSession"]({
                harness: chosen.harness,
                fresh: o.fresh,
                terminal,
                machine,
                runtime: chosen.runtime,
                provider: chosen.provider,
                model: chosen.model,
                routing: { decidedBy: chosen.decidedBy, trace: chosen.trace },
                // This process execs the harness: its PID is the harness's, which a move to another terminal signals.
                pid: process.pid,
                // Held in vibestd's memory only, for this harness's restart in place (vibest update).
                ...(Object.keys(passed).length > 0 ? { env: passed } : {}),
              }),
            )
          }),
        )
        const main = yield* Launch.coordinatorCommand({
          harness: chosen.harness,
          root,
          provider: chosen.provider ?? null,
          model: chosen.model ?? null,
          passEnv: CALLER_ENV,
          session,
        }).pipe(Effect.provide(Harness.layer))
        const child = Launch.harnessChildEnv(process.env, env, main.env)
        delete process.env[Launch.MAIN_ENV]
        return yield* Effect.sync(() => exec(main.file, main.args, child))
      }
      // Elsewhere: a terminal in the parent workspace whose shell runs this command again. Inside herdr that terminal is
      // the runtime's to focus; outside, attach to it (like `cao launch`).
      const inHerdr = here !== undefined
      const opened = yield* withVibest((yield* caller).claim, (client) =>
        client.Launch({
          argv: again,
          focus: inHerdr || !o.headless,
          machine,
          ...(runtimeKind !== undefined ? { runtime: runtimeKind } : {}),
        }),
      )
      yield* Console.log(`the main agent is starting in ${opened.place}`)
      if (inHerdr || o.headless || !opened.attach) return
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const [file, ...args] = opened.attach
      yield* spawner.exitCode(
        ChildProcess.make(file!, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
      )
    })

const send = Command.make("send", { id, message: text("message") }, (o) =>
  Effect.gen(function* () {
    const message = yield* input(o.message, "message")
    const sent = yield* vibest((client) => client.Send({ id: o.id, message }))
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
    // No caller and no start: anyone may ask, and asking never starts vibestd. Protocol is reported, not required.
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
        // pid / instance / command / startedAt: what the vibestd that answered says; null from one too old to say.
        // recordedPid: vibestd.pid's, not verified to be that vibestd.
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

/** A session as the user reads it: its `name` (the wire and database name) is its `title`. */
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
    // The coordinator lists its project's sessions. The command line lists the project of this directory, or every
    // session when it is not one (`all`: the request asks for them). `--all` includes exited ones.
    Effect.gen(function* () {
      const cwd = (yield* Path.Path).resolve(".")
      const located = yield* projectRoot(cwd).pipe(Effect.option)
      yield* vibest((client) => client.List({ stopped: o.all, ...(Option.isNone(located) ? { all: true } : {}) })).pipe(
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

const providerFlag = Flag.String("provider").pipe(Flag.withDescription("Only this provider's models"), Flag.optional)
const modelsOf = (harnesses: ReadonlyArray<HarnessId>, provider: Option.Option<string>) =>
  listAllModels(harnesses, Option.getOrNull(provider)).pipe(Effect.flatMap(json))

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
    "The models each harness accepts, as the harness reports them: start a session with one entry's harness, provider (null: leave it out) and model. Local, does not need vibestd",
  ),
)

const harness = Command.make("harness").pipe(
  Command.withDescription("The harnesses vibest runs; local, does not need vibestd"),
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.forEach(
        HARNESS_IDS,
        (h) =>
          Effect.gen(function* () {
            const host = yield* Harness
            const summary = { harness: h, binary: (yield* Harnesses).get(h).binary }
            if (!(yield* host.available(h)))
              return { ...summary, available: false, defaultModel: null, error: `${summary.binary} is not on PATH` }
            return yield* host.models(h, null).pipe(
              Effect.map((models) => ({
                ...summary,
                available: true,
                defaultModel: models.find((m) => m.default)?.model ?? null,
                error: null,
              })),
              Effect.catchTag("HarnessUnavailable", (e) =>
                Effect.succeed({ ...summary, available: true, defaultModel: null, error: e.message }),
              ),
            )
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.flatMap(json), Effect.provide(Harness.layer)),
    ).pipe(
      Command.withAlias("ls"),
      Command.withDescription(
        "Each harness: its binary, whether it is on PATH and the model it runs by default (null: the harness chooses, or error says why it could not be asked)",
      ),
    ),
    Command.make("models", { harness: Argument.Literals("harness", HARNESS_IDS), provider: providerFlag }, (o) =>
      modelsOf([o.harness], o.provider),
    ).pipe(Command.withDescription("The models one harness accepts; same JSON as vibest models")),
  ]),
)

// ---- project ----

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
          const created = yield* createProject(o.directory, o.from)
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
        "Only for working on several repositories together; a single git repository is already a project (cd into it and run vibest). Copies them into a new project directory, one folder each: `vibest project create ~/work/combo --from ~/code/shop --from ~/code/admin` makes ~/work/combo/shop and ~/work/combo/admin (your originals are untouched); ~/work/combo itself must not be inside a git repository. Then `cd ~/work/combo && vibest`: the main agent works there, and each subagent gets its own copy with the same folders. Local, does not need vibestd; an agent may not run it",
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

// ---- local tools ----

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

/**
 * A harness hook's event, sent to vibestd as it came (`hookCall`: a timeout and one retry), with the session's headers
 * and its conversation id when the adapter reads one from `raw`. Does not start vibestd; writes no file.
 */
const notify = (
  adapter: HarnessAdapter,
  sessionId: string,
  raw: string,
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
    yield* hookCall(layout.socket, headers, send)
  }).pipe(Effect.ignore)

/**
 * A harness plugin's turn-end bridge (`vibest integration stop --harness <h>`, Cursor's): its adapter's `turnEnd` reads
 * the event. Missing identity, a non-object, or an event the adapter ignores sends nothing. Failures exit 0. Writes
 * OSC 7501 idle (runtime-port.md §5) and sends the event as `TurnEnd`; vibestd keeps the turn end and writes the result.
 */
export const integrationStop = (adapter: HarnessAdapter, raw: string) =>
  Effect.gen(function* () {
    const agent = yield* nonempty("VIBEST_AGENT")
    const sessionId = yield* nonempty("VIBEST_SESSION_ID")
    if (!agent || !sessionId) return
    const event = jsonObject(raw)
    if (!event || !adapter.turnEnd?.(event, agent === "coordinator")) return
    yield* writeTerminalStatus("idle")
    yield* notify(adapter, sessionId, raw, (client) => client.TurnEnd({ sessionId, harness: adapter.id, event: raw }))
  }).pipe(Effect.ignore)

/**
 * A harness plugin's user-prompt bridge (`vibest integration prompt --harness <h>`): its adapter's `userPrompt` reads the
 * event. The main agent, a nested agent, or text that is not the user typing sends nothing. Failures exit 0. Sends the
 * event as `Prompt` (vibestd notes the turn start and records the round), then OSC 7501 working.
 */
export const integrationPrompt = (adapter: HarnessAdapter, raw: string) =>
  Effect.gen(function* () {
    const agent = yield* nonempty("VIBEST_AGENT")
    const sessionId = yield* nonempty("VIBEST_SESSION_ID")
    if (!agent || !sessionId) return
    if (promptOf(adapter, agent, raw) === undefined) return
    yield* notify(adapter, sessionId, raw, (client) => client.Prompt({ sessionId, harness: adapter.id, event: raw }))
    yield* writeTerminalStatus("working")
  }).pipe(Effect.ignore)

const hookHarness = Flag.Literals("harness", HARNESS_IDS).pipe(Flag.withDescription("The harness whose hook this is"))

const stop = Command.make("stop", { harness: hookHarness }, (o) =>
  Effect.gen(function* () {
    yield* integrationStop(
      (yield* Harnesses).get(o.harness),
      yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)),
    )
  }).pipe(Effect.ignore),
).pipe(
  Command.withDescription(
    "A harness plugin's turn-end bridge: its turn-end event JSON on stdin. Does not start vibestd; failures exit 0",
  ),
)

const prompt = Command.make("prompt", { harness: hookHarness }, (o) =>
  Effect.gen(function* () {
    yield* integrationPrompt(
      (yield* Harnesses).get(o.harness),
      yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)),
    )
  }).pipe(Effect.ignore),
).pipe(
  Command.withDescription(
    "A harness plugin's user-prompt bridge: the prompt event JSON on stdin. Does not start vibestd; failures exit 0",
  ),
)

// Any failure exits non-zero, which the hook script turns into a refusal.
const guard = Command.make("guard", { harness: hookHarness }, (o) =>
  Effect.gen(function* () {
    const { guardAnswer } = (yield* Harnesses).get(o.harness)
    if (!guardAnswer) return yield* Effect.fail(new Error(`${o.harness} has no pre-tool hook`))
    // No VIBEST_AGENT fails: the hook refuses.
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

/**
 * The main agent's start after a restart (`vibest update`, a move): vibestd types it into the main agent's own shell once
 * its harness has ended. It never starts vibestd and waits through a handoff (for a moment nothing answers).
 */
const integrationStart = (exec: Exec) =>
  Command.make("start", { id }, (o) =>
    Effect.gen(function* () {
      const got = yield* Effect.flatMap(caller, (c) =>
        withVibest(c.claim, (client) => client["Session.Start"]({ id: o.id }), { start: false }).pipe(
          Effect.retry({
            while: (e) => (e as { readonly _tag?: string })._tag === "DaemonUnavailable",
            schedule: Schedule.spaced("500 millis"),
            times: 60,
          }),
        ),
      )
      const { root } = yield* projectRoot((yield* Path.Path).resolve("."))
      const main = yield* Launch.coordinatorCommand({
        harness: got.harness,
        root,
        provider: got.provider,
        model: got.model,
        passEnv: CALLER_ENV,
        session: Effect.succeed({
          sessionId: o.id,
          harnessSessionId: got.harnessSessionId,
          projectId: got.projectId,
          runtime: got.runtime,
        }),
      }).pipe(Effect.provide(Harness.layer))
      const child = Launch.harnessChildEnv(process.env, got.env ?? {}, main.env)
      delete process.env[Launch.MAIN_ENV]
      return yield* Effect.sync(() => exec(main.file, main.args, child))
    }),
  ).pipe(Command.withDescription("Internal: the main agent's harness started again in its shell, on its conversation"))

const integration = (exec: Exec) =>
  Command.make("integration").pipe(
    Command.withDescription(
      "Internal: called by vibest's plugin in each harness (user prompt, turn-end result, pre-tool guard) and by a main agent's restart; not for direct use",
    ),
    Command.withSubcommands([guard, prompt, stop, integrationStart(exec)]),
  )

/** herdr's own integration line per harness: herdr knows an agent's status only through it. */
/** One finding: ok, a problem with the command that fixes it, or a note. */
type Finding = { readonly mark: "ok" | "problem" | "note"; readonly text: string; readonly fix?: string }
const MARKS = { ok: "✓", problem: "✗", note: "·" } as const

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const sections: Array<{ readonly title: string; readonly findings: ReadonlyArray<Finding> }> = []
    const width = Math.max(...HARNESS_IDS.map((h) => h.length))

    // The coding agents vibest starts.
    const harnesses = yield* Effect.forEach(
      HARNESS_IDS,
      (h) =>
        preflight(h, null, null).pipe(
          Effect.map((models): Finding => ({
            mark: "ok",
            text: `${h.padEnd(width)}  ${models.length} models, default ${models.find((m) => m.default)?.model ?? "chosen by the harness"}`,
          })),
          Effect.catchTag("HarnessUnavailable", (e) =>
            Effect.succeed<Finding>({ mark: "problem", text: `${h.padEnd(width)}  ${e.message}` }),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(Harness.layer))
    sections.push({ title: "Coding agents (the harnesses vibest starts)", findings: harnesses })
    const installs = yield* extraVibests
    if (installs.length > 0) sections.push({ title: "vibest on PATH", findings: installs })
    const usable = HARNESS_IDS.filter((_, i) => harnesses[i]!.mark === "ok")

    // vibestd: the background service. Runtimes and plugins are loaded there, so doctor starts it when it is not running.
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

    if (talks) {
      const ask = <A, E>(f: (c: VibestClient) => Effect.Effect<A, E>) =>
        RpcClient.withHeaders(connect(layout.socket).pipe(Effect.flatMap(f)), protocolHeaders()).pipe(
          Effect.scoped,
          Effect.option,
        )
      // Runtimes: where agents run (herdr, …). Each one checks what it needs for the coding agents above.
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
      // Plugins.
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

/** `vibest update` failed: the latest version could not be read, or its installer failed. */
export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", { message: Schema.String }) {}

/** A full semver version (`1.2.3`, `-pre.1`, `+build`), what `compareVersions` takes. */
export const isSemver = (v: string) =>
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(v)

/** Where install.sh and the release archives are: the latest GitHub release of this repository. */
const RELEASES = "https://github.com/vibest-dev/vibest/releases/latest/download"

/**
 * How this vibest was installed. npm: its launcher (bin/vibest.cjs) sets VIBEST_HARNESSES. install.sh: the binary runs from
 * `<share>/versions/<version>/bin/vibest`. Anything else (a build, `bun main.ts`) has nothing to update.
 */
export const installMethod = (self: ReadonlyArray<string>, harnesses: string | undefined) => {
  if (harnesses) return { kind: "npm" } as const
  const m = self.length === 1 ? /^(.+)\/versions\/[^/]+\/bin\/vibest$/.exec(self[0]!) : null
  return m ? ({ kind: "curl", share: m[1]! } as const) : undefined
}

/**
 * Which package manager owns the vibest at `real` (a real path, links resolved): bun's global directory, or an npm
 * prefix (`<prefix>/lib/node_modules/@vibest/…`: npm under fnm, mise, nvm, Homebrew). Undefined: neither, as far as
 * the path shows.
 */
export const ownerOf = (real: string) => {
  if (real.includes("/.bun/install/global/node_modules/")) return { kind: "bun" } as const
  const npm = /^(.+)\/lib\/node_modules\/@vibest\//.exec(real)
  return npm ? ({ kind: "npm", prefix: npm[1]! } as const) : undefined
}

/**
 * The command that upgrades the npm-installed vibest whose binary is at `real`, with the package manager that owns it
 * (not the first npm on PATH). bun is also given the platform package: it may skip an optional dependency.
 * ponytail: an npm prefix's own npm is taken to be `<prefix>/bin/npm`, as fnm, mise, nvm and Homebrew lay it out.
 */
export const upgradeCommand = (real: string, platform = `${process.platform}-${process.arch}`) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? ["bun", "add", "-g", "@vibest/cli@beta", `@vibest/cli-${platform}@beta`]
    : owner?.kind === "npm"
      ? [`${owner.prefix}/bin/npm`, "install", "-g", "--prefix", owner.prefix, "@vibest/cli@beta"]
      : ["npm", "install", "-g", "@vibest/cli@beta"]
}

/** The command that removes the vibest on PATH at `link` (real path `real`). */
export const removeCommand = (link: string, real: string) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? "bun remove -g @vibest/cli"
    : owner?.kind === "npm"
      ? `${shellQuote(`${owner.prefix}/bin/npm`)} uninstall -g --prefix ${shellQuote(owner.prefix)} @vibest/cli`
      : `rm ${shellQuote(link)}`
}

/**
 * More than one `vibest` on PATH (one per real file, in PATH order): each with the version it reports, the first as the
 * one that runs, the others with how to remove them. Empty when there is one or none.
 */
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

/** The latest version: the `beta` tag on the npm registry (npm_config_registry), or the release's `version` file. */
const latestVersion = (
  url: string,
  read: (body: HttpClientResponse.HttpClientResponse) => Effect.Effect<string, unknown>,
) =>
  HttpClient.get(url).pipe(
    // Nothing published there yet (a local build installed from a tarball): say so, not a raw HTTP error.
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

/** How often the user's own commands look for a newer vibest; a failed look waits as long. */
const UPDATE_CHECK_EVERY = Duration.hours(24)

/**
 * One line on stderr when a newer vibest is out: on the user's own `vibest`, `vibest status` and `vibest doctor`, never an
 * agent's. Reads the registry (or the release) at most once a day, cached in $VIBEST_HOME/update-check.json, and waits
 * at most 2 s for it; any failure says nothing. VIBEST_NO_UPDATE_CHECK=1 turns it off.
 */
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

/** `argv` with the terminal's stdio and `env` added; fails unless it exits 0. */
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

/** What a replacement that did not happen left of vibestd, for the user and for whoever reads the exit status. */
const LEFT: Record<ReplaceFailed["outcome"], string> = {
  declined: "vibestd not replaced: you declined; it still runs the vibest it was started with",
  busy: "vibestd not replaced: it refused to stop (see above); it still runs the vibest it was started with",
  unchanged: "vibestd not replaced: it still runs the vibest it was started with",
  unknown: "vibestd was asked to stop; whether it, the new one or none runs now is not known (see vibest status)",
  other: "vibestd was asked to stop, and another vibestd answers now, not the vibest asked for",
}

/**
 * Replace vibestd during update. Only a no on the terminal leaves update successful. Any other outcome is said at once (a
 * later step may fail) and returned, so the update fails (non-zero) once the rest is done. Nothing is retried.
 */
const replaceForUpdate = (target: { readonly version: string; readonly command: ReadonlyArray<string> }) =>
  replaceDaemon(target).pipe(
    Effect.as(undefined),
    Effect.catchTag("ReplaceFailed", (e) =>
      e.outcome === "declined"
        ? Console.log(`${LEFT.declined}. To replace it later: vibest daemon restart`).pipe(Effect.as(undefined))
        : Console.error(`${LEFT[e.outcome]}. ${e.message}`).pipe(Effect.as(LEFT[e.outcome])),
    ),
  )

/**
 * What `vibest update` does with the running vibestd, from its Ping (as herdr's restart policy): keep it when it already
 * is this protocol, version and binary; hand it off when it can; otherwise replace it (Daemon.Stop, then a new start).
 */
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

/** How long `vibest update` watches for the new vibestd after a handoff was accepted. */
const HANDOFF_WATCH = Duration.seconds(45)

/**
 * The handoff (Daemon.Handoff): the old vibestd checks the new vibest, drains, starts it and lets it take over. The outcome
 * is what Ping shows afterwards, said as herdr says it, with the command to run next. Undefined when the new one runs.
 */
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
      // Refused or lost: Ping says which.
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

/**
 * The agents still on an old integration: asked once on a terminal (or `--yes`), then handed to vibestd, which restarts
 * them in place once this process has exited: this `vibest update` may run inside one of them (the main agent's shell),
 * and ending that harness would end it too. Returns why the step failed, if it did.
 */
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
      // The user, or the project's main agent from its own shell: its integration is the one an update replaces.
      if (Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT"))) !== Guard.COORDINATOR)
        yield* userOnly("update")
      const self = yield* VibestCommand
      const method = installMethod(self, Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))))
      const layout = yield* Layout
      // 1. Install, the way this vibest was installed. One already current (or not installed by either) does only the
      // steps after it, which also covers an upgrade made with npm or bun directly.
      let target: { readonly version: string; readonly command: ReadonlyArray<string> } = {
        version: VERSION,
        command: self,
      }
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
          // The package manager that owns this binary, from its real path.
          const fs = yield* FileSystem.FileSystem
          const pm = upgradeCommand(yield* fs.realPath(self[0]!).pipe(Effect.orElseSucceed(() => self[0]!)))
          // install.sh of the release, read whole before it runs (a cut-off download must not run half a script), into this install.
          const installer =
            method.kind === "npm"
              ? runInherit(pm)
              : runInherit(
                  ["sh", "-c", 'script=$(curl -fsSL "$0/install.sh") && printf \'%s\\n\' "$script" | sh', releases],
                  { VIBEST_INSTALL: method.share, VIBEST_DOWNLOAD_URL: releases },
                )
          yield* installer.pipe(
            Effect.mapError((e) => new UpdateError({ message: `${e.message}; vibestd not attempted` })),
          )
          // install.sh puts each version in a directory of its own: the new vibest is there, not at this one's path.
          target = {
            version: latest,
            command: method.kind === "curl" ? [`${method.share}/versions/${latest}/bin/vibest`] : self,
          }
        }
      }
      // More than one vibest on PATH: which one runs, and how to remove the others.
      for (const f of yield* extraVibests)
        yield* Console.log(
          `${f.mark === "problem" ? "warning: " : ""}${f.text}${f.fix ? `; remove it with: ${f.fix}` : ""}`,
        )
      // 2. vibestd, from its Ping: keep, hand off or restart; the plan and its reason first.
      const running = Option.getOrUndefined(yield* readPing(layout.socket))
      const plan = daemonPlan(running, target)
      // Nothing runs: nothing to plan, and no agent to restart.
      if (plan.action === "none") return
      yield* Console.log(`vibestd: ${plan.action}. ${plan.reason}.`)
      const failed =
        plan.action === "handoff"
          ? yield* handoffDaemon(running!, target)
          : plan.action === "restart"
            ? yield* replaceForUpdate(target)
            : undefined
      if (failed !== undefined) return yield* new UpdateError({ message: `vibest ${target.version}: ${failed}` })
      // 3. The agents still on the old integration, asked about once.
      const agents = yield* restartAgents(target.version, yes, "vibest update")
      if (agents !== undefined) return yield* new UpdateError({ message: agents })
    }),
).pipe(
  Command.withAlias("upgrade"),
  Command.withDescription(
    "Update vibest the way it was installed (install.sh: the latest GitHub release; npm: @vibest/cli@beta with the package manager that installed it), hand the running vibestd over to it (agents keep running), then offer to restart the agents still on the old integration in place, with their conversations",
  ),
)

export const command = (host: Daemon.Host, exec: Exec) =>
  Command.make("vibest", mainFlags, startMain(exec)).pipe(
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
      integration(exec),
      doctor,
      update,
      herdrCommands(userOnly),
    ]),
  )

/** A failure as one `Tag: message` line on stderr; the CLI's own usage errors were already printed with the help. */
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

/** Exit codes: 0 done, 1 the command failed, 2 bad usage, 130 interrupted. */
export const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const error = Cause.findErrorOption(exit.cause)
  onExit(Option.isSome(error) && CliError.isCliError(error.value) ? 2 : 1)
}
