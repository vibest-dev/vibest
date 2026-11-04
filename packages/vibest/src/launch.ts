import {
  encodeCommand,
  Harness,
  Harnesses,
  HarnessUnavailable,
  type HarnessId,
  sessionPlugin,
} from "@vibest/core/harness"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { type Machine, type Runtime } from "@vibest/core/runtimes"
import { LaunchFailed } from "@vibest/core/sessions"
// `vibest` (architecture.md D4): the main agent. The Coordinator always runs at the main checkout's root; the CLI
// execs the harness when it already is in such a terminal, and otherwise has a terminal at the root run `vibest`
// again (runtime-port.md §3 `open`: the runtime decides which workspace the terminal lands in).
import { SystemPromptDirUnsafe, systemPromptRoot, writeSystemPrompt } from "@vibest/core/system-prompt"
import { Config, Effect, FileSystem, Option } from "effect"

/** An unusable temporary directory is the user's to fix and fails the start; any other error there is a defect. */
const unsafeOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch((e) => (e instanceof SystemPromptDirUnsafe ? Effect.fail(e) : Effect.die(e))))

/**
 * The harness, its arguments and extra env to exec as a Coordinator at `root`; writes its system prompt file (the one
 * vibestd made from its entry agent definition's rules and the project's). `session` runs only
 * after every check that can refuse the launch, since it supersedes the running Coordinator's launch; exec can still fail.
 */
export const coordinatorCommand = Effect.fn("coordinatorCommand")(function* <E, R>(input: {
  readonly harness: HarnessId
  readonly root: string
  readonly provider: string | null
  readonly model: string | null
  /** The runtime's variables `vibest` in the Coordinator's shell needs to find its pane's owner, passed on when set. */
  readonly passEnv: ReadonlyArray<string>
  /** `Project.CoordinatorSession`: the coordinator's session id, the conversation to reopen, and where it runs. */
  readonly session: Effect.Effect<
    {
      readonly sessionId: string
      readonly harnessSessionId: string | null
      readonly projectId: string
      readonly runtime?: string | undefined
      /** The entry agent definition's name (VIBEST_AGENT) and skills (VIBEST_SKILLS). */
      readonly agent: string
      readonly skills: ReadonlyArray<string>
      /** Its system prompt text (`entrySystemPrompt`), written here on every start. */
      readonly systemPrompt: string
    },
    E,
    R
  >
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
  const base = yield* harness.plugin(input.harness)
  // The temporary directory is checked before `session`, which supersedes the running Coordinator's launch.
  yield* unsafeOnly(systemPromptRoot)
  const env: Record<string, string> = {
    VIBEST_HARNESS: input.harness,
    VIBEST_HOME: layout.home,
    VIBEST_COMMAND: encodeCommand(vibest),
  }
  // What `vibest` in the Coordinator's shell needs to find its pane's owner; a harness may hand its shell less than it got.
  for (const name of input.passEnv) {
    const value = yield* Config.option(Config.String(name))
    if (Option.isSome(value)) env[name] = value.value
  }
  const saved = yield* input.session
  const pluginDir = yield* sessionPlugin(adapter, base, saved.sessionId, saved.skills).pipe(Effect.orDie)
  const systemPromptFile = yield* unsafeOnly(writeSystemPrompt(saved.sessionId, saved.systemPrompt))
  // The project folder the Coordinator writes in (--add-dir must exist).
  yield* (yield* FileSystem.FileSystem)
    .makeDirectory(layout.artifacts(saved.projectId), { recursive: true })
    .pipe(Effect.ignore)
  let harnessSessionId = saved.harnessSessionId
  if (harnessSessionId !== null && adapter.canResume && !(yield* adapter.canResume(input.root, harnessSessionId)))
    harnessSessionId = null
  const commandEnv: Record<string, string> = {
    ...env,
    VIBEST_AGENT: saved.agent,
    ...(saved.skills.length > 0 ? { VIBEST_SKILLS: saved.skills.join(",") } : {}),
    VIBEST_SESSION_ID: saved.sessionId,
    VIBEST_PROJECT_ID: saved.projectId,
    VIBEST_PROJECT_DIR: layout.project(saved.projectId),
    ...(saved.runtime !== undefined ? { VIBEST_RUNTIME: saved.runtime } : {}),
  }
  return {
    file: adapter.binary,
    args: adapter.coordinatorArgs({
      root: input.root,
      projectDir: layout.project(saved.projectId),
      systemPromptFile,
      provider: input.provider,
      model: input.model,
      sessionId: harnessSessionId,
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
    .pipe(Effect.mapError((e) => new LaunchFailed({ message: e.message })))
  return terminal
})
