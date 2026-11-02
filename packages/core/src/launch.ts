// `vibest` (architecture.md D4): the main agent. The Coordinator always runs at the main checkout's root; the CLI
// execs the harness when it already is in such a terminal, and otherwise has a terminal at the root run `vibest`
// again (runtime-port.md §3 `open`: the runtime decides which workspace the terminal lands in).
import { Config, Crypto, Effect, Option } from "effect"

import { COORDINATOR } from "./guard.ts"
import { encodeCommand, Harness, Harnesses, HarnessUnavailable, type HarnessId } from "./harness.ts"
import { Layout, VibestCommand, writeAtomic } from "./paths.ts"
import { projectKey } from "./project-create.ts"
import { coordinatorRules, projectText } from "./rules.ts"
import { type Machine, type Runtime } from "./runtimes.ts"
import { LaunchFailed } from "./sessions.ts"

/**
 * The harness, its arguments and extra env to exec as a Coordinator at `root`; writes its rules file. `session` runs only
 * after every check that can refuse the launch, since it supersedes the running Coordinator's launch; exec can still fail.
 */
export const coordinatorCommand = Effect.fn("coordinatorCommand")(function* <E, R>(input: {
  readonly harness: HarnessId
  readonly root: string
  readonly provider: string | null
  readonly model: string | null
  /** The runtime's variables `vibest` in the Coordinator's shell needs to find its pane's owner, passed on when set. */
  readonly passEnv: ReadonlyArray<string>
  /** `Project.CoordinatorSession`: the coordinator's session id, and the conversation to reopen. */
  readonly session: Effect.Effect<{ readonly sessionId: string; readonly harnessSessionId: string | null }, E, R>
  /** `CoordinatorSessionReady`: records a conversation id vibest chose up front, before the harness starts. */
  readonly record: (sessionId: string, harnessSessionId: string) => Effect.Effect<void, E, R>
}) {
  const adapter = (yield* Harnesses).get(input.harness)
  const harness = yield* Harness
  const layout = yield* Layout
  const vibest = yield* VibestCommand
  const unavailable = (message: string) => new HarnessUnavailable({ harness: input.harness, message })
  if (!adapter.coordinatorArgs)
    return yield* unavailable(`${input.harness} is not currently supported as the coordinator`)
  const providerError = adapter.checkProvider(input.provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(input.harness))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  // The plugin's pre-tool hook keeps a Coordinator from editing files and from what else it refuses (guard.ts).
  const pluginDir = yield* harness.plugin(input.harness)
  const key = yield* projectKey(input.root).pipe(Effect.orDie)
  const rulesFile = layout.coordinatorRules(key)
  const rules = coordinatorRules({ ...(yield* projectText(layout.project(key))) })
  yield* writeAtomic(rulesFile, rules).pipe(Effect.orDie)
  const env: Record<string, string> = {
    VIBEST_AGENT: COORDINATOR,
    VIBEST_HOME: layout.home,
    VIBEST_COMMAND: encodeCommand(vibest),
  }
  // What `vibest` in the Coordinator's shell needs to find its pane's owner; a harness may hand its shell less than it got.
  for (const name of input.passEnv) {
    const value = yield* Config.option(Config.String(name))
    if (Option.isSome(value)) env[name] = value.value
  }
  const saved = yield* input.session
  let harnessSessionId = saved.harnessSessionId
  if (harnessSessionId !== null && adapter.canResume && !(yield* adapter.canResume(input.root, harnessSessionId)))
    harnessSessionId = null
  // The bridge inbox (Claude) attaches by conversation id, so a new one is chosen and recorded now, not after the first turn.
  let newSessionId: string | undefined
  if (harnessSessionId === null && adapter.ownSessionId && adapter.inbox === "bridge") {
    newSessionId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
    yield* input.record(saved.sessionId, newSessionId)
  }
  const commandEnv: Record<string, string> = { ...env, VIBEST_SESSION_ID: saved.sessionId }
  return {
    file: adapter.binary,
    args: adapter.coordinatorArgs({
      root: input.root,
      rules,
      rulesFile,
      provider: input.provider,
      model: input.model,
      sessionId: harnessSessionId,
      ...(newSessionId ? { newSessionId } : {}),
      pluginDir,
      env: commandEnv,
    }),
    env: commandEnv,
  }
})

/** `argv` (a `vibest`) marked as run in `root`'s parent workspace, by construction: the hidden `--in-parent <root>`. */
export const inParent = (argv: ReadonlyArray<string>, root: string) => [...argv, "--in-parent", root]

/** `argv` to run again at `root` from below it: still marked when this run was, so the runtime is not asked again. */
export const again = (argv: ReadonlyArray<string>, root: string, marked: boolean) =>
  marked ? inParent(argv, root) : argv

/**
 * A terminal at `root` (in the project's workspace there, which the runtime keeps: a tab beside the main agent's other
 * terminals) whose shell runs `argv`; its address. `focus` asks the runtime to focus it — the terminal the user is
 * waiting to see (§3: `open` keeps the terminal with the project's others either way).
 */
export const openInParentWorkspace = Effect.fn("Launch.openInParentWorkspace")(function* (
  h: Runtime,
  machine: Machine,
  input: {
    readonly root: string
    readonly argv: ReadonlyArray<string>
    readonly label: string
    readonly home: string
    /** The user is waiting to see the terminal (the runtime focuses it when it can). */
    readonly focus?: boolean | undefined
  },
) {
  // VIBEST_HOME so the `vibest` in that shell talks to this vibestd. `--in-parent` so the vibest that runs there
  // knows it is in place without asking the runtime, which does not report a just-made workspace as the parent.
  // The shell stays after the command: a start that fails (or a main agent the user quits) shows its error in the
  // pane and leaves a shell, not a closing terminal — and a pane that stays is one the last-pane guard still covers.
  const terminal = yield* h
    .open(machine, {
      project: input.root,
      cwd: input.root,
      argv: ["sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh", ...inParent(input.argv, input.root)],
      env: { VIBEST_HOME: input.home },
      label: input.label,
      ...(input.focus === true ? { focus: true } : {}),
    })
    .pipe(Effect.mapError((e) => new LaunchFailed({ message: e.message, tail: "" })))
  return terminal
})
