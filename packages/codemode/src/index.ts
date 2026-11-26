import { SchemaType } from "@vibest/util/schema-type"
import { Runtime } from "psychoscript/effect"

export { renderDeclarations, renderToolSignature, schemaToType, type DeclarationTool } from "./declarations.ts"

export const toCodeModeIdentifier = SchemaType.toIdentifier

export { fromBytes, Host, parseProgram, Runtime, SnapshotError, toBytes, type Snapshot } from "psychoscript/effect"

export const SuspendError = Runtime.SuspendError

export {
  checkSyntax,
  CodeModeRuntime,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_TIMEOUT_MS,
  layer,
  make,
  Service,
  type ExecuteInput,
  type Interface,
  type ToolDefinition,
  type ToolDispatcher,
  type ToolMap,
  type ToolPolicy,
} from "./service.ts"
