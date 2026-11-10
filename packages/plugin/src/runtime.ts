import { type Effect, Schema, type Stream, type Types } from "effect"

import type { Transform } from "./registration.ts"

export interface Machine {
  readonly id: string
  readonly target?: string
  readonly link?: Readonly<Record<string, string>>
}

export interface Located {
  readonly missing: boolean
  readonly terminals: ReadonlyMap<string, Terminal>
  readonly as?: string
  readonly note?: string
}

export interface Terminal {
  readonly machine: string
  readonly id: string
}

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  code: Schema.Literals(["not_found", "busy", "unreachable", "incompatible", "failed"]),
  message: Schema.String,
}) {}

export type MachineStatus =
  | { readonly status: "online" }
  | { readonly status: "offline" | "blocked"; readonly reason: string }

export type AgentState = "idle" | "working" | "blocked" | "unknown"

export interface RuntimeCheck {
  readonly ok: boolean
  readonly subject?: string
  readonly text: string
  readonly fix?: string
}

export interface RuntimeReport {
  readonly name: string
  readonly checks: ReadonlyArray<RuntimeCheck>
}

export interface Seen {
  readonly turn: number
  readonly seen: number | null
}

export type RuntimeEvent =
  | { readonly type: "exited"; readonly terminal: Terminal }
  | { readonly type: "seen"; readonly terminal: Terminal }
  | { readonly type: "state"; readonly terminal: Terminal; readonly state: AgentState }
  | { readonly type: "reset"; readonly machine: string }

export type CallerValues = Readonly<Record<string, string | undefined>>

export interface RuntimeCaller {
  readonly env: ReadonlyArray<string>
  readonly terminal: (env: CallerValues) => Effect.Effect<string | undefined, unknown>
  readonly ready?: (env: CallerValues) => Effect.Effect<boolean, unknown>
  readonly missing?: string
  readonly target?: (env: CallerValues, named?: string) => string | undefined
}

export interface RuntimeDefinition {
  readonly id: string
  readonly caller?: RuntimeCaller
  readonly status: (machine: Machine) => Effect.Effect<MachineStatus>

  readonly open: (
    machine: Machine,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      readonly env: Readonly<Record<string, string>>
      readonly label: string
      readonly near?: Terminal
      readonly split?: boolean
      readonly focus?: boolean
    },
  ) => Effect.Effect<Terminal, RuntimeError>
  readonly send: (
    terminal: Terminal,
    input: { readonly text?: string; readonly keys?: ReadonlyArray<string> },
  ) => Effect.Effect<void, RuntimeError>
  readonly read: (terminal: Terminal, lines: number) => Effect.Effect<string, RuntimeError>
  readonly process: (
    terminal: Terminal,
  ) => Effect.Effect<{ readonly running: boolean; readonly exitCode?: number }, RuntimeError>
  readonly close: (terminal: Terminal) => Effect.Effect<void, RuntimeError>
  readonly events: Stream.Stream<RuntimeEvent>

  readonly state?: (terminal: Terminal) => Effect.Effect<AgentState, RuntimeError>
  readonly session?: (terminal: Terminal) => Effect.Effect<string | null, RuntimeError>
  readonly seen?: (terminal: Terminal) => Effect.Effect<Seen, RuntimeError>
  readonly see?: (terminal: Terminal, turn: number) => Effect.Effect<void, RuntimeError>
  readonly run?: (terminal: Terminal, argv: ReadonlyArray<string>) => Effect.Effect<void, RuntimeError>
  readonly focus?: (terminal: Terminal) => Effect.Effect<void, RuntimeError>
  readonly exec?: (
    machine: Machine,
    argv: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<{ readonly code: number; readonly output: string }, RuntimeError>
  readonly present?: (terminal: Terminal, info: Readonly<Record<string, string>>) => Effect.Effect<void, RuntimeError>
  readonly prepare?: (machine: Machine) => Effect.Effect<void, RuntimeError>
  readonly doctor?: (machine: Machine, harnesses: ReadonlyArray<string>) => Effect.Effect<RuntimeReport>
  readonly attach?: (machine: Machine) => ReadonlyArray<string>
  readonly link?: () => Effect.Effect<Readonly<Record<string, string>> | undefined>
  readonly locate?: (machine: Machine, sessions: ReadonlyMap<string, string>) => Effect.Effect<Located>
}

export interface RuntimeEditor {
  list(): ReadonlyArray<RuntimeDefinition>
  get(id: string): RuntimeDefinition | undefined
  add(definition: RuntimeDefinition): void
  update(id: string, update: (definition: Types.Mutable<RuntimeDefinition>) => void): void
  remove(id: string): void
}

export interface RuntimeDomain {
  readonly transform: Transform<RuntimeEditor>
  readonly reload: () => Effect.Effect<void>
}
