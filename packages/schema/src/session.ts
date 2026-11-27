import { Schema } from "effect"

import { Sender } from "./event.ts"

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])

export type AgentStatus = typeof AgentStatus.Type

export const ExecutionState = Schema.Literals([
  "none",
  "open",
  "completed",
  "failed",
  "interrupted",
  "lost",
  "not_started",
])

export type ExecutionState = typeof ExecutionState.Type

export const InboxStatus = Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"])

export type InboxStatus = typeof InboxStatus.Type

export { canonicalTarget, formatTerminalTarget, SessionRef, Terminal, TerminalTarget } from "./terminal.ts"

export const RuntimeLocation = Schema.Union([
  Schema.Struct({ socketPath: Schema.String }),
  Schema.Struct({ session: Schema.String }),
])

export type RuntimeLocation = typeof RuntimeLocation.Type

export const RuntimeMachine = Schema.Struct({
  id: Schema.String,
  target: Schema.optional(Schema.String),
})

export type RuntimeMachine = typeof RuntimeMachine.Type

export const InboxRow = Schema.Struct({
  id: Schema.Number,
  sender: Sender,
  recipient: Schema.NullOr(Schema.String),
  message: Schema.String,
  status: InboxStatus,
})

export type InboxRow = typeof InboxRow.Type

export const Detail = Schema.Struct({
  sender: Sender,
  message: Schema.String,
})

export type Detail = typeof Detail.Type

const PREVIEW = 120

const titledSender = (agent: string) => (agent === "" ? "" : `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`)

const clipPreview = (s: string) => {
  const cps = [...s]

  return cps.length <= PREVIEW ? s : `${cps.slice(0, PREVIEW - 1).join("")}…`
}

const agentHead = (sender: Extract<Detail["sender"], { readonly type: "agent" }>) => {
  const id = sender.session.slice(0, 8)

  if (sender.agent !== undefined)
    return `Message from @${titledSender(sender.agent)} · ${sender.title ?? ""} (${sender.machine === undefined ? id : `${id} on ${sender.machine}`})`

  return sender.machine === undefined
    ? `Message from @${titledSender(id)}`
    : `Message from @${titledSender(sender.machine)} · (${id} on ${sender.machine})`
}

const senderHead = (sender: Detail["sender"]) => {
  switch (sender.type) {
    case "vibest":
      return "Message from Vibest"
    case "user":
      return "Message from You"
    case "plugin":
      return `Message from Vibest · ${sender.plugin}`
    case "agent":
      return agentHead(sender)
  }
}

export const formatDelivery = (detail: ReadonlyArray<Detail>) =>
  detail
    .map((entry) => `${senderHead(entry.sender)}\n${clipPreview(entry.message.trim().split("\n")[0] ?? "")}`)
    .join("\n\n")

export const Taken = Schema.Struct({
  execution: Schema.Number,
  ids: Schema.Array(Schema.Number),
  content: Schema.String,
  detail: Schema.Array(Detail),
})

export type Taken = typeof Taken.Type

export type HarnessId = string

export const addPluginHint =
  "a harness comes from a plugin: add one that provides it to `plugins` in vibest.json in the vibest home"

export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()(
  "HarnessUnavailable",
  {
    harness: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class RuntimeUnreachable extends Schema.TaggedError<RuntimeUnreachable>()(
  "RuntimeUnreachable",
  {
    session: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class NoRuntime extends Schema.TaggedError<NoRuntime>()(
  "NoRuntime",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class RuntimeIncompatible extends Schema.TaggedError<RuntimeIncompatible>()(
  "RuntimeIncompatible",
  {
    session: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class NoSuchSession extends Schema.TaggedError<NoSuchSession>()(
  "NoSuchSession",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class AmbiguousSession extends Schema.TaggedError<AmbiguousSession>()(
  "AmbiguousSession",
  {
    prefix: Schema.String,
    matches: Schema.Array(Schema.String),
  },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `${this.prefix} matches ${this.matches.join(", ")}; retry with more characters of the session id`
  }
}

export class MoveRefused extends Schema.TaggedError<MoveRefused>()(
  "MoveRefused",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class AllocationFailed extends Schema.TaggedError<AllocationFailed>()(
  "AllocationFailed",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
  "SessionBusy",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class NotReady extends Schema.TaggedError<NotReady>()(
  "NotReady",
  {
    id: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class NoCallingSession extends Schema.TaggedError<NoCallingSession>()(
  "NoCallingSession",
  {},
  { httpApiStatus: 422 },
) {
  override get message() {
    return "vibest run is run by an agent in a session; to start working, run vibest in a terminal"
  }
}

export class UnknownAgent extends Schema.TaggedError<UnknownAgent>()(
  "UnknownAgent",
  {
    agent: Schema.String,
    known: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
    invalid: Schema.optional(Schema.String),
  },
  { httpApiStatus: 404 },
) {
  override get message() {
    if (this.invalid !== undefined) return `agent definition ${this.agent} is invalid: ${this.invalid}`
    const known = this.known.map((definition) => `${definition.id} (${definition.description})`).join("; ")

    return `no agent definition ${this.agent}; registered: ${known || "none"}`
  }
}

export const runnableNote = (runnable: ReadonlyArray<string>) =>
  runnable.length === 0 ? "" : `; this machine can run: ${runnable.join(", ")}`

export class NoHarnessChosen extends Schema.TaggedError<NoHarnessChosen>()(
  "NoHarnessChosen",
  {
    runnable: Schema.Array(Schema.String),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    return `no harness to inherit: name one, for example \`vibest run claude -- <prompt>\`${runnableNote(this.runnable)}`
  }
}

export const NO_RUNTIME_DETECTED = "no runtime was detected in this environment"

export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()(
  "LaunchFailed",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class NotInRepository extends Schema.TaggedError<NotInRepository>()(
  "NotInRepository",
  { path: Schema.String },
  { httpApiStatus: 422 },
) {
  override get message() {
    return `${this.path} is not inside a git repository`
  }
}

export const describeSpawn = (s: {
  harness: string
  provider?: string | undefined
  model?: string | undefined
  decidedBy: Readonly<Record<string, string>>
}) => {
  const plugins = [...new Set(Object.values(s.decidedBy))]
  const by = plugins.length === 0 ? "" : ` (chosen by plugin ${plugins.join(", ")})`

  return [s.harness, s.provider, s.model].filter(Boolean).join(" / ") + by
}

export const HarnessModel = Schema.Struct({
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  name: Schema.String,
  default: Schema.Boolean,
})

export const HarnessChoice = Schema.Struct({
  harness: Schema.String,
  binary: Schema.String,
  problem: Schema.NullOr(Schema.String),
  models: Schema.Array(HarnessModel),
})

export type HarnessChoice = typeof HarnessChoice.Type

export const AgentListing = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      plugin: Schema.String,
      harness: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      mcpServers: Schema.optional(Schema.Array(Schema.String)),
      warnings: Schema.optional(Schema.Array(Schema.String)),
      system: Schema.String,
    }),
  ),
  invalid: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      source: Schema.String,
      error: Schema.String,
      plugin: Schema.String,
    }),
  ),
})

export type AgentListing = typeof AgentListing.Type
