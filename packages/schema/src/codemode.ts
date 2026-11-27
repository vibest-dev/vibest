import { Schema } from "effect"

export { decodeJsonOption, deepEqualJson, isJsonObject } from "./json.ts"

export * as CodeMode from "./codemode.ts"

export const MAX_TIMEOUT_MS = 300_000
export const MAX_TOOL_CALLS = 100
export const MAX_LOG_BYTES = 256 * 1024

const boundedInt = (max: number) =>
  Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(max))

export const ExecutionLimits = Schema.Struct({
  timeoutMs: Schema.optional(boundedInt(MAX_TIMEOUT_MS)),
  maxToolCalls: Schema.optional(boundedInt(MAX_TOOL_CALLS)),
  maxLogBytes: Schema.optional(boundedInt(MAX_LOG_BYTES)),
}).annotate({ identifier: "CodeModeExecutionLimits" })

export type ExecutionLimits = typeof ExecutionLimits.Type

export const ToolCallStatus = Schema.Literals(["ok", "error", "cancelled"]).annotate({
  identifier: "CodeModeToolCallStatus",
})

export type ToolCallStatus = typeof ToolCallStatus.Type

export const ToolCallRecord = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  path: Schema.String,
  status: ToolCallStatus,
  durationMs: Schema.Number,
}).annotate({ identifier: "CodeModeToolCallRecord" })

export type ToolCallRecord = typeof ToolCallRecord.Type

export const ErrorKind = Schema.Literals([
  "ParseError",
  "ScriptError",
  "Timeout",
  "MemoryLimit",
  "Aborted",
  "ToolLimit",
  "ToolDenied",
  "SandboxError",
]).annotate({ identifier: "CodeModeErrorKind" })

export type ErrorKind = typeof ErrorKind.Type

export const ExecutionError = Schema.Struct({
  kind: ErrorKind,
  name: Schema.optional(Schema.String),
  message: Schema.String,
  stack: Schema.optional(Schema.String),
}).annotate({ identifier: "CodeModeExecutionError" })

export type ExecutionError = typeof ExecutionError.Type

export const StoreWrites = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.Json),
  delete: Schema.Array(Schema.String),
}).annotate({ identifier: "CodeModeStoreWrites" })

export type StoreWrites = typeof StoreWrites.Type

export const ExecutionSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.optional(Schema.Json),
  logs: Schema.Array(Schema.String),
  calls: Schema.Array(ToolCallRecord),
  storeWrites: StoreWrites,
  truncated: Schema.optional(Schema.Boolean),
  outputFile: Schema.optional(Schema.String),
}).annotate({ identifier: "CodeModeExecutionSuccess" })

export type ExecutionSuccess = typeof ExecutionSuccess.Type

export const ExecutionFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error: ExecutionError,
  logs: Schema.Array(Schema.String),
  calls: Schema.Array(ToolCallRecord),
  truncated: Schema.optional(Schema.Boolean),
  outputFile: Schema.optional(Schema.String),
}).annotate({ identifier: "CodeModeExecutionFailure" })

export type ExecutionFailure = typeof ExecutionFailure.Type

export const ExecutionResult = Schema.Union([ExecutionSuccess, ExecutionFailure]).annotate({
  identifier: "CodeModeExecutionResult",
})

export type ExecutionResult = typeof ExecutionResult.Type

export const ExecuteRequest = Schema.Struct({
  code: Schema.String,
  directory: Schema.optional(Schema.String),
  servers: Schema.optional(Schema.Array(Schema.String)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  state: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  limits: Schema.optional(ExecutionLimits),
}).annotate({ identifier: "CodeModeExecuteRequest" })

export type ExecuteRequest = typeof ExecuteRequest.Type

export const DeclarationsResult = Schema.Struct({
  declarations: Schema.String,
  servers: Schema.Array(Schema.String),
  toolCount: Schema.Number,
}).annotate({ identifier: "CodeModeDeclarationsResult" })

export type DeclarationsResult = typeof DeclarationsResult.Type

export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "CodeModeUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}
