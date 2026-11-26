import { CodeMode } from "@vibest/schema/codemode"
import { SchemaType } from "@vibest/util/schema-type"
import { Context, Effect, Layer, Option, Predicate, Result, type Schema } from "effect"
import { Host, parseProgram, Runtime, type Diagnostic, type Json } from "psychoscript/effect"

import { renderDeclarations, type DeclarationTool } from "./declarations.ts"

export * as CodeModeRuntime from "./service.ts"

const encoder = new TextEncoder()

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_TOOL_CALLS = 20
export const DEFAULT_MAX_LOG_BYTES = 32 * 1024
const MAX_SANDBOX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_STORE_VALUE_CHARS = 256 * 1024
const MAX_STORE_TOTAL_CHARS = 1024 * 1024

const RESERVED_BINDINGS = new Set([
  "tools",
  "console",
  "store",
  "load",
  "eval",
  "Function",
  "JSON",
  "Object",
  "Array",
  "Math",
  "Date",
  "Promise",
  "Map",
  "Set",
  "RegExp",
  "URL",
  "Error",
  "TypeError",
  "RangeError",
  "globalThis",
])

export interface ToolDefinition extends DeclarationTool {
  readonly execute: (
    args: Schema.Json | undefined,
  ) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>
}

export type ToolMap = ReadonlyArray<ToolDefinition>

export type ToolDispatcher = (
  server: string,
  tool: string,
  args: Schema.Json | undefined,
) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>

export type ToolPolicy = (path: string) => Result.Result<void, string>

export interface ExecuteInput {
  readonly code: string
  readonly tools?: ToolMap | undefined
  readonly callTool?: ToolDispatcher | undefined
  readonly allowTool?: ToolPolicy | undefined
  readonly bindings?: Schema.JsonObject | undefined
  readonly state?: Schema.JsonObject | undefined
  readonly limits?: CodeMode.ExecutionLimits | undefined
}

export interface Interface {
  readonly execute: (input: ExecuteInput) => Effect.Effect<CodeMode.ExecutionResult>
  readonly checkSyntax: (code: string) => Result.Result<void, string>
  readonly renderDeclarations: (tools: ReadonlyArray<DeclarationTool>) => string
}

export class Service extends Context.Service<Service, Interface>()("vibest/CodeModeRuntime") {}

const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback

  return Math.min(max, Math.max(1, Math.floor(value)))
}

export const checkSyntax = (code: string): Result.Result<void, string> => {
  const parsed = parseProgram(code)

  if (!parsed.ok) return Result.fail(parsed.error.message)

  return Result.succeed(undefined)
}

const mapErrorKind = (kind: string): CodeMode.ErrorKind => {
  if (kind === "ParseError" || kind === "UnsupportedSyntax") return "ParseError"

  if (kind === "TimeoutExceeded") return "Timeout"

  if (kind === "ForbiddenTool") return "ToolDenied"

  if (kind === "ToolCallLimit") return "ToolLimit"

  return "ScriptError"
}

const mapDiagnostic = (error: Diagnostic): CodeMode.ExecutionError => ({
  kind: mapErrorKind(error.kind),
  name: error.kind,
  message: error.message,
})

const toPsychoscriptJson = (value: Schema.Json): Json => {
  if (value === null || Predicate.isBoolean(value) || Predicate.isNumber(value) || Predicate.isString(value)) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(toPsychoscriptJson)
  }

  const out: Record<string, Json> = {}

  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = toPsychoscriptJson(v)
  }

  return out
}

const toPsychoscriptBindings = (bindings: Schema.JsonObject | undefined) => {
  const filtered: Record<string, Json> = {}

  for (const [key, value] of Object.entries(bindings ?? {})) {
    if (RESERVED_BINDINGS.has(key) || value === undefined) continue
    filtered[key] = toPsychoscriptJson(value)
  }

  return filtered
}

const execute = Effect.fn("CodeModeRuntime.execute")(function* (
  input: ExecuteInput,
): Effect.fn.Return<CodeMode.ExecutionResult> {
  const timeoutMs = clampLimit(input.limits?.timeoutMs, DEFAULT_TIMEOUT_MS, CodeMode.MAX_TIMEOUT_MS)
  const maxToolCalls = clampLimit(input.limits?.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, CodeMode.MAX_TOOL_CALLS)
  const maxLogBytes = clampLimit(input.limits?.maxLogBytes, DEFAULT_MAX_LOG_BYTES, CodeMode.MAX_LOG_BYTES)

  const staticByPath = new Map<string, ToolDefinition>()
  const staticServerTools = new Map<string, Array<string>>()

  for (const tool of input.tools ?? []) {
    const serverJs = SchemaType.toIdentifier(tool.server)
    const toolJs = SchemaType.toIdentifier(tool.name)
    staticByPath.set(`${tool.server}.${tool.name}`, tool)
    staticByPath.set(`${serverJs}.${toolJs}`, tool)
    staticByPath.set(`${tool.server}.${toolJs}`, tool)
    staticByPath.set(`${serverJs}.${tool.name}`, tool)

    const list = staticServerTools.get(serverJs) ?? []

    if (!list.includes(toolJs)) list.push(toolJs)
    staticServerTools.set(serverJs, list)
  }

  const stored = new Map<string, string>()
  let storedChars = 0

  for (const [key, value] of Object.entries(input.state ?? {})) {
    const json = JSON.stringify(value)

    if (json !== undefined) {
      stored.set(key, json)
      storedChars += key.length + json.length
    }
  }

  const writes = new Map<string, Schema.Json | undefined>()
  const calls: Array<CodeMode.ToolCallRecord> = []
  let toolCallCount = 0
  let policyViolation: string | undefined
  let toolLimitViolation: string | undefined

  const loadFn = Host.fn(([key]): Schema.Json | undefined => {
    if (!Predicate.isString(key)) {
      throw Host.fail("TypeError", "load() key must be a string")
    }

    const raw = stored.get(key)

    if (raw === undefined) return undefined

    return Option.getOrUndefined(CodeMode.decodeJsonOption(JSON.parse(raw)))
  })

  const storeFn = Host.fn(([key, value]) => {
    if (!Predicate.isString(key)) {
      throw Host.fail("TypeError", "store() key must be a string")
    }

    const previous = stored.has(key) ? key.length + stored.get(key)!.length : 0

    if (value === undefined) {
      stored.delete(key)
      storedChars -= previous
      writes.set(key, undefined)

      return
    }

    const decoded = CodeMode.decodeJsonOption(value)

    if (Option.isNone(decoded)) {
      throw Host.fail("TypeError", `store(${JSON.stringify(key)}) value is not JSON-serializable`)
    }

    const json = JSON.stringify(decoded.value)

    if (json.length > MAX_STORE_VALUE_CHARS) {
      throw Host.fail(
        "RangeError",
        `store(${JSON.stringify(key)}) value exceeds maximum size of ${MAX_STORE_VALUE_CHARS} chars`,
      )
    }

    const next = storedChars - previous + key.length + json.length

    if (next > MAX_STORE_TOTAL_CHARS) {
      throw Host.fail("RangeError", `store exceeds total limit of ${MAX_STORE_TOTAL_CHARS} chars`)
    }

    stored.set(key, json)
    storedChars = next
    writes.set(key, decoded.value)
  })

  const toolsNamespace = Host.namespace<never>({
    keys: (nsPath) => {
      if (nsPath.length === 0) return [...staticServerTools.keys()]

      if (nsPath.length === 1) return staticServerTools.get(nsPath[0]!) ?? []

      return []
    },
    resolve: (nsPath) => {
      if (nsPath.length !== 2) {
        return Host.missing(`tools.${nsPath.join(".")} is not a tool function — call tools.<server>.<tool>(args)`)
      }

      const rawServer = nsPath[0]!
      const rawTool = nsPath[1]!
      const lookupPath = `${rawServer}.${rawTool}`
      const staticTool = staticByPath.get(lookupPath)

      if (!staticTool && !input.callTool) {
        return Host.missing(`Unknown tool "${lookupPath}"`)
      }

      return Host.fn(
        ([rawArgs]): Effect.Effect<Schema.Json | undefined, Host.Failure> =>
          Effect.gen(function* () {
            const server = staticTool?.server ?? rawServer
            const toolName = staticTool?.name ?? rawTool
            const toolPath = `${server}.${toolName}`
            const startedAt = performance.now()

            if (input.allowTool) {
              const decision = input.allowTool(toolPath)

              if (Result.isFailure(decision)) {
                policyViolation = decision.failure
                calls.push({
                  server,
                  tool: toolName,
                  path: toolPath,
                  status: "error",
                  durationMs: Math.max(0, performance.now() - startedAt),
                })

                return yield* Effect.fail(Host.fail("ForbiddenTool", decision.failure))
              }
            }

            toolCallCount += 1

            if (toolCallCount > maxToolCalls) {
              toolLimitViolation = `Execution exceeded maximum tool calls limit (${maxToolCalls})`
              calls.push({
                server,
                tool: toolName,
                path: toolPath,
                status: "error",
                durationMs: Math.max(0, performance.now() - startedAt),
              })

              return yield* Effect.fail(Host.fail("ToolCallLimit", toolLimitViolation))
            }

            const argsOption = rawArgs === undefined ? Option.some(undefined) : CodeMode.decodeJsonOption(rawArgs)

            if (Option.isNone(argsOption)) {
              calls.push({
                server,
                tool: toolName,
                path: toolPath,
                status: "error",
                durationMs: Math.max(0, performance.now() - startedAt),
              })

              return yield* Effect.fail(Host.fail("TypeError", "Tool arguments are not valid JSON"))
            }

            const callEffect = staticTool
              ? staticTool.execute(argsOption.value)
              : input.callTool!(server, toolName, argsOption.value)

            const outcome = yield* Effect.result(callEffect)
            const durationMs = Math.max(0, performance.now() - startedAt)

            if (Result.isFailure(outcome)) {
              calls.push({ server, tool: toolName, path: toolPath, status: "error", durationMs })

              return yield* Effect.fail(Host.fail("ToolError", outcome.failure.message))
            }

            calls.push({ server, tool: toolName, path: toolPath, status: "ok", durationMs })

            return outcome.success
          }),
        { type: "async", idempotent: false },
      )
    },
  })

  const runtime = Runtime.make({
    globals: () => ({
      tools: toolsNamespace,
      load: loadFn,
      store: storeFn,
    }),
    limits: {
      timeoutMs,
      maxOutputBytes: Math.max(maxLogBytes, MAX_SANDBOX_OUTPUT_BYTES),
    },
    translate: {
      functions: "drop",
      promises: "await",
    },
  })

  const rawResult = yield* runtime.execute(input.code, {
    bindings: toPsychoscriptBindings(input.bindings),
  })

  const rawLogs = rawResult.logs ?? []
  const logs: Array<string> = []
  let logBytes = 0

  for (const line of rawLogs) {
    const lineBytes = encoder.encode(line).byteLength

    if (logBytes + lineBytes <= maxLogBytes) {
      logs.push(line)
      logBytes += lineBytes
      continue
    }

    const remaining = maxLogBytes - logBytes

    if (remaining > 0) {
      const { read } = encoder.encodeInto(line, new Uint8Array(remaining))
      logs.push(line.slice(0, read))
      logBytes = maxLogBytes
    }

    break
  }

  if (policyViolation !== undefined) {
    return {
      ok: false,
      error: { kind: "ToolDenied", name: "ForbiddenTool", message: policyViolation },
      logs,
      calls,
    }
  }

  if (toolLimitViolation !== undefined) {
    return {
      ok: false,
      error: { kind: "ToolLimit", name: "ToolCallLimit", message: toolLimitViolation },
      logs,
      calls,
    }
  }

  if (!rawResult.ok) {
    return {
      ok: false,
      error: mapDiagnostic(rawResult.error),
      logs,
      calls,
    }
  }

  const set: Record<string, Schema.Json> = {}
  const deleted: Array<string> = []

  for (const [key, value] of writes) {
    if (value === undefined) {
      deleted.push(key)
    } else {
      set[key] = value
    }
  }

  const decodedValue =
    rawResult.value === undefined ? Option.some(undefined) : CodeMode.decodeJsonOption(rawResult.value)

  if (Option.isNone(decodedValue)) {
    return {
      ok: false,
      error: { kind: "SandboxError", message: "Sandbox return value is not valid JSON" },
      logs,
      calls,
    }
  }

  return {
    ok: true,
    ...(decodedValue.value !== undefined && { value: decodedValue.value }),
    logs,
    calls,
    storeWrites: { set, delete: deleted },
  }
})

export const make = (): Effect.Effect<Interface> =>
  Effect.succeed({
    execute,
    checkSyntax,
    renderDeclarations,
  })

export const layer = () => Layer.effect(Service, make())
