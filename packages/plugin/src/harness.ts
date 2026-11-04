// Harness adapter API: what differs between the agent CLIs vibest runs (claude, pi and cursor are built in; a plugin adds
// another with `context.harness.register`). Core reads these fields and never branches on a harness id.
import type { Effect, FileSystem, Path } from "effect"

/**
 * What every harness integration reports, whatever the CLI: one contract (a plugin harness implements it too).
 * - ready: the harness takes input; `pid` is its own process (what a restart signals).
 * - conversation: the harness's conversation id changed (/clear, a first turn end).
 * - turn.start: a turn began; `origin` typed (the person, in the pane) or inbox (vibest's delivery, `inbox` its row ids).
 * - turn.end: a turn ended; `failure.kind` limited makes a usage-limit move possible.
 * - blocked: waiting on a permission or a question.
 */
export type IntegrationEvent =
  | { readonly type: "ready"; readonly pid?: number; readonly conversation?: string }
  | { readonly type: "conversation"; readonly conversation: string }
  | {
      readonly type: "turn.start"
      readonly origin: "typed" | "inbox"
      readonly text: string
      readonly inbox?: ReadonlyArray<number>
    }
  | {
      readonly type: "turn.end"
      readonly outcome: "completed" | "failed" | "interrupted"
      readonly text?: string
      readonly failure?: { readonly kind: "limited" | "auth" | "other"; readonly message: string }
    }
  | { readonly type: "blocked"; readonly reason: "permission" | "question"; readonly detail?: string }

/**
 * A tool call as the guard reads it, whatever the CLI calls the tool: its kind, its own name (any case), the shell
 * command, the paths it names (as given: relative to `cwd`, `~`, or a file URL), and the working directory.
 */
export interface ToolCall {
  readonly kind: "shell" | "edit" | "read" | "search" | "other"
  readonly name: string
  readonly command?: string
  readonly paths: ReadonlyArray<string>
  readonly cwd: string
}

/** One model as the harness reports it; vibest fills in the harness and the requested provider. */
export interface RawModel {
  readonly model: string
  readonly provider?: string | undefined
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly default: boolean
}

/**
 * How a harness lists its models: run `binary args`; with `request`, write it and keep stdin open (a server that exits
 * at EOF before it answers) and stop at the first output `answer` can read; without, `answer` reads the output to its
 * end. `answer` returns undefined while the output holds no list.
 */
export interface ModelLister {
  readonly args: (provider: string | null) => ReadonlyArray<string>
  readonly request?: string
  readonly answer: (lines: ReadonlyArray<string>) => ReadonlyArray<RawModel> | undefined
}

/** What a session is started with. */
export interface LaunchInput {
  readonly worktree: string
  /** The session's project folder (VIBEST_PROJECT_DIR), which it reads and writes with its file tools. */
  readonly projectDir: string
  /** The session's system prompt, regenerated on every start ($TMPDIR/vibest/<id>/system-prompt.md); a harness with no
   * system-prompt flag gets its text in the first prompt instead. */
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  /** The conversation to continue (resume), or the one vibest chose up front (`conversation: "assigned"`). */
  readonly sessionId: string | null
  readonly resume: boolean
  /** vibest's bundled integration for a built-in harness; empty for a plugin harness, which finds its own files. */
  readonly pluginDir: string
  /** argv that runs vibest, for the permission to run `vibest report`. */
  readonly vibest: ReadonlyArray<string>
  /** vibest's variables for the session's shell (VIBEST_SESSION_ID, VIBEST_AGENT …). */
  readonly env: Readonly<Record<string, string>>
}

/** What `vibest` starts an entry agent (the main agent) with. */
export interface CoordinatorInput {
  /** Repository root, its working directory. */
  readonly root: string
  /** The project folder (VIBEST_PROJECT_DIR): the one place the entry agent writes files. */
  readonly projectDir: string
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  /** The conversation to reopen, or null: the harness starts a new one. */
  readonly sessionId: string | null
  readonly pluginDir: string
  readonly env: Readonly<Record<string, string>>
}

/** The session's pane while the harness starts, as a startup adapter sees it. */
export interface StartupPane {
  /** The last 40 lines on screen. */
  readonly screen: Effect.Effect<string>
  readonly sendKeys: (keys: ReadonlyArray<string>) => Effect.Effect<void>
}

/** Per launch: makes the step vibestd runs on every tick until the harness is ready. */
export type Startup = Effect.Effect<(pane: StartupPane) => Effect.Effect<void>>

export interface HarnessAdapter {
  readonly id: string
  /** Executable that must be on PATH. */
  readonly binary: string
  /** `assigned`: vibest picks the conversation id up front; `reported`: the integration reports it after launch. */
  readonly conversation: "assigned" | "reported"
  /** No system-prompt flag: the system prompt goes in front of the first prompt. */
  readonly systemPromptInPrompt: boolean
  readonly interruptKey: string
  /** Harness-specific startup handling while vibestd waits for ready (Claude: its trust / bypass menus). */
  readonly startup?: Startup
  /**
   * How vibest hands inbox rows to the session: typed into its pane (`type`), or taken by its integration (`poll`,
   * HTTP `/inbox/poll` and `/inbox/ack`).
   */
  readonly delivery: "type" | "poll"
  /** A subagent's rows when they differ from `delivery` (Claude: its plugin's submit does not reach the harness after an
   * Esc in the pane, so a subagent's tasks and sends are typed). Absent: as `delivery`. */
  readonly subagentDelivery?: "type" | "poll"
  /**
   * `plugin-dir`: vibest's skills ship in the plugin directory (`skills/<name>`) and the harness offers every one it
   * finds there, with no flag to pick (Claude Code). Each session then gets its own copy of the directory holding only
   * the skills its agent definition names. Absent: the integration picks them itself (Pi reads VIBEST_SKILLS).
   */
  readonly skills?: "plugin-dir"
  /**
   * The integration reports what the harness does: `ready` when it takes input, `turn.start` when it works, `blocked`
   * when it waits on the person. vibest then reads only liveness from the runtime (and idle, for a turn that ended
   * without its event). False: the runtime's agent state says all of it.
   */
  readonly reportsState: boolean
  /** Error message when this harness cannot use `provider`, else undefined. */
  readonly checkProvider: (provider: string | null) => string | undefined
  readonly launchArgs: (input: LaunchInput) => ReadonlyArray<string>
  /** Entry-agent argv. Absent: the harness cannot run an entry agent. */
  readonly coordinatorArgs?: (input: CoordinatorInput) => ReadonlyArray<string>
  readonly models: ModelLister
  /** The pre-tool hook's answer in the harness's format; `reason` refuses the call. Absent: the harness guards over HTTP. */
  readonly guardAnswer?: (reason: string | undefined) => unknown
  /**
   * For a CLI that only has shell hooks: its raw hook payload (forwarded by `vibest integration event --harness <id>
   * <hook>`) as neutral events, or as the tool call its pre-tool hook asks about. Undefined ignores it.
   */
  readonly decode?: (
    hook: string,
    payload: Readonly<Record<string, unknown>>,
  ) => ReadonlyArray<IntegrationEvent> | { readonly tool: ToolCall } | undefined
  /** Whether conversation `sessionId` can be reopened at `root`. Absent: it can. */
  readonly canResume?: (
    root: string,
    sessionId: string,
  ) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>
}

export interface HarnessRegistry {
  /** Register for the plugin's lifetime; an id already registered is a setup failure. */
  readonly register: (adapter: HarnessAdapter) => Effect.Effect<void>
}
