// Runtime plugin API (runtime-port.md, `runtime-api.ts`, accepted). Rules that keep it small and extensible:
// - No API version field: the API ships with vibest. Additions are optional members; a breaking change ships in a
//   vibest release and plugins update with it.
// - Core checks whether an optional member exists, never which runtime it is.
// - One error type; `code` says what happened.
// - Connections are the plugin's business: it opens, reuses and re-opens them per machine inside its own scope.
import { type Effect, Schema, type Stream } from "effect"

/** `local`, or a saved machine; `target` is the runtime's to read (an ssh target, a host label, …). */
export interface Machine {
  readonly id: string
  readonly target?: string
}

/** A terminal: the machine it is on and the runtime's own id there (opaque to core). Stored on the Agent row. */
export interface Terminal {
  readonly machine: string
  readonly id: string
}

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  /** not_found | busy | unreachable (transient, retried) | incompatible (needs the user) | failed (anything else) */
  code: Schema.Literals(["not_found", "busy", "unreachable", "incompatible", "failed"]),
  message: Schema.String,
}) {}

export type MachineStatus =
  | { readonly status: "online" }
  | { readonly status: "offline" | "blocked"; readonly reason: string }

export type AgentState = "idle" | "working" | "blocked" | "unknown"

/** One line of `vibest doctor` about a runtime: what is fine or not, and the command that fixes it. */
export interface RuntimeCheck {
  readonly ok: boolean
  /** What the line is about: a harness id, or none for the runtime itself. */
  readonly subject?: string
  readonly text: string
  readonly fix?: string
}

/** What `vibest doctor` shows for a runtime on a machine. */
export interface RuntimeReport {
  /** The runtime as the user knows it, with its version when known (`herdr 0.9.5`). */
  readonly name: string
  readonly checks: ReadonlyArray<RuntimeCheck>
}

export type RuntimeEvent =
  | { readonly type: "exited"; readonly terminal: Terminal }
  | { readonly type: "state"; readonly terminal: Terminal; readonly state: AgentState }
  /** A machine's connection was re-made or its runtime restarted: core re-reads what it needs there. */
  | { readonly type: "reset"; readonly machine: string }

/** What a runtime plugin registers. */
export interface Runtime {
  /** Stored on each Agent row (`runtime.kind`); unique among loaded plugins. */
  readonly kind: string
  /** Usable on this machine now. `local` not installed → blocked with the reason. */
  readonly status: (machine: Machine) => Effect.Effect<MachineStatus>

  /** A terminal running `argv` exactly, kept with the project's other terminals (the runtime decides how). */
  readonly open: (
    machine: Machine,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      readonly env: Readonly<Record<string, string>>
      readonly label: string
      /** Put it beside this terminal when possible. */
      readonly near?: Terminal
      /** As a split beside `near` instead of a tab of its own (`vibest run --peer`), when the runtime can. */
      readonly split?: boolean
      /** Focus the terminal when the runtime has such a notion (a terminal the user is waiting to see). */
      readonly focus?: boolean
    },
  ) => Effect.Effect<Terminal, RuntimeError>
  /** Type text and/or press keys (enter, esc, ctrl+c, …). */
  readonly send: (
    terminal: Terminal,
    input: { readonly text?: string; readonly keys?: ReadonlyArray<string> },
  ) => Effect.Effect<void, RuntimeError>
  /** The last `lines` lines of output. */
  readonly read: (terminal: Terminal, lines: number) => Effect.Effect<string, RuntimeError>
  /** Is its program still running; its exit code once it is not. `not_found` once the terminal is gone. */
  readonly process: (
    terminal: Terminal,
  ) => Effect.Effect<{ readonly running: boolean; readonly exitCode?: number }, RuntimeError>
  readonly close: (terminal: Terminal) => Effect.Effect<void, RuntimeError>
  /**
   * Pushed changes, every machine: at least `exited` for each terminal whose program ended or that closed, and `reset`
   * when the runtime lost track (core then reads each of its terminals again once). Core never polls.
   */
  readonly events: Stream.Stream<RuntimeEvent>

  // Optional. Missing → core's fallback in brackets.
  /** What the runtime sees of the agent; `not_found` when it names no agent in that terminal (core reads "absent"). [vibest's harness integration only] */
  readonly state?: (terminal: Terminal) => Effect.Effect<AgentState, RuntimeError>
  /** The harness conversation id the runtime's own agent record names, when it has one. [the harness's reports only] */
  readonly session?: (terminal: Terminal) => Effect.Effect<string | null, RuntimeError>
  /**
   * Run `argv` in an existing terminal once it is back at an idle shell (its program ended): the counterpart of `open` for
   * a terminal that already exists. Fails when the terminal is gone or its shell does not come back. [no restart in
   * place: `vibest update` and a usage-limit move leave such a terminal's agent for the user to restart]
   */
  readonly run?: (terminal: Terminal, argv: ReadonlyArray<string>) => Effect.Effect<void, RuntimeError>
  /** One-off command on a machine. [run it in a hidden terminal: `open`, wait for exit, `read`] */
  readonly exec?: (
    machine: Machine,
    argv: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<{ readonly code: number; readonly output: string }, RuntimeError>
  /**
   * Labels and tokens shown on a terminal. [the `label` given to `open`] The keys vibest sends: `agent`, `harness`,
   * `title`, `definition` and `session` label the terminal; `project` and `live` label the project's workspace. Any
   * other key a caller passes is the caller's own; a runtime shows only what it knows a key for.
   */
  readonly present?: (terminal: Terminal, info: Readonly<Record<string, string>>) => Effect.Effect<void, RuntimeError>
  /** Set a machine up on the runtime's side (`vibest machine add`). [the user does it] */
  readonly prepare?: (machine: Machine) => Effect.Effect<void, RuntimeError>
  /** What `vibest doctor` shows: anything the runtime needs for `harnesses` to work in it, with fixes. [its `status` only] */
  readonly doctor?: (machine: Machine, harnesses: ReadonlyArray<string>) => Effect.Effect<RuntimeReport>
  /** The command that shows this runtime on a machine to the user. [none] */
  readonly attach?: (machine: Machine) => ReadonlyArray<string>
}

/** In the plugin context, beside `agent.hook`. Registered for the plugin's lifetime; its connections close with it. */
export interface RuntimeRegistry {
  readonly register: (runtime: Runtime) => Effect.Effect<void>
}

// export default Plugin.define({
//   id: "runtime-tern",
//   effect: (context) => context.runtime.register({ kind: "tern", status, open, send, read, process, close, attach: () => ["tern"] }),
// })
