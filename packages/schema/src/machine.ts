import { Schema, Struct } from "effect"

export class MachineFailed extends Schema.TaggedError<MachineFailed>()("MachineFailed", { message: Schema.String }) {}

export class UnknownMachine extends Schema.TaggedError<UnknownMachine>()("UnknownMachine", {
  machine: Schema.String,
  machines: Schema.Array(Schema.String),
}) {
  override get message() {
    const known =
      this.machines.length === 0 ? "none is added (vibest machine add)" : `machines: ${this.machines.join(", ")}`
    return `unknown machine ${JSON.stringify(this.machine)}; ${known}`
  }
}

export class MachineUnavailable extends Schema.TaggedError<MachineUnavailable>()("MachineUnavailable", {
  machine: Schema.String,
  message: Schema.String,
}) {}

export class MachineIncompatible extends Schema.TaggedError<MachineIncompatible>()("MachineIncompatible", {
  machine: Schema.String,
  message: Schema.String,
}) {}

export class AlreadyAdded extends Schema.TaggedError<AlreadyAdded>()("AlreadyAdded", {
  machine: Schema.String,
  id: Schema.String,
}) {
  override get message() {
    return `this is the vibestd already added as ${this.machine} (${this.id.slice(0, 8)}); use that name`
  }
}

export const MachineState = Schema.Literals(["connecting", "connected", "unreachable", "different"])
export type MachineState = typeof MachineState.Type

export const MachineNote = Schema.Struct({
  plugin: Schema.optional(Schema.String),
  message: Schema.String,
  fix: Schema.optional(Schema.String),
})
export type MachineNote = typeof MachineNote.Type

export const RuntimeThere = Schema.Struct({
  kind: Schema.String,
  status: Schema.Literals(["online", "offline", "blocked"]),
  reason: Schema.optional(Schema.String),
  link: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type RuntimeThere = typeof RuntimeThere.Type

export const RuntimeView = Schema.Struct({
  kind: Schema.String,
  status: RuntimeThere.fields.status,
  reason: Schema.optional(Schema.String),
  here: Schema.Struct({
    visible: Schema.Boolean,
    as: Schema.optional(Schema.String),
    note: Schema.optional(Schema.String),
  }),
})
export type RuntimeView = typeof RuntimeView.Type

export const MachineInfo = Schema.Struct({
  name: Schema.String,
  target: Schema.String,
  id: Schema.String,
  state: MachineState,
  since: Schema.Number,
  reason: Schema.optional(Schema.String),
  connectedAt: Schema.Number,
  vibestd: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  runtimes: Schema.optional(Schema.Array(RuntimeView)),
  runtimesAt: Schema.optional(Schema.Number),
  notes: Schema.optional(Schema.Array(Schema.Struct({ ...MachineNote.fields, at: Schema.Number }))),
})
export type MachineInfo = typeof MachineInfo.Type

export const ListedMachine = MachineInfo.mapFields(Struct.pick(["name", "state", "since", "reason"]))
export type ListedMachine = typeof ListedMachine.Type

export class NoProject extends Schema.TaggedError<NoProject>()("NoProject", { message: Schema.String }) {}

export class NoCommit extends Schema.TaggedError<NoCommit>()("NoCommit", { message: Schema.String }) {}

export const OUTBOX_ITEM_MAX = 1024 * 1024

export const PROMPT_MAX = 1024 * 1024

export class PromptTooLarge extends Schema.TaggedError<PromptTooLarge>()("PromptTooLarge", { bytes: Schema.Number }) {
  override get message() {
    return `the prompt is ${this.bytes} bytes; another machine takes at most ${PROMPT_MAX} bytes (1 MiB)`
  }
}

export const OutboxItem = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  recipient: Schema.String,
  kind: Schema.Literals(["send", "notice"]),
  content: Schema.String,
  cut: Schema.optional(Schema.Boolean),
})
export type OutboxItem = typeof OutboxItem.Type
