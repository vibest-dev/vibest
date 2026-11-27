import { Automation } from "@vibest/schema/automation"
import type { CodeMode as CodeModeSchema } from "@vibest/schema/codemode"
import { Effect, Option, Result, type Schema } from "effect"

import type { CodeMode } from "../codemode.ts"
import { ToolOutput } from "../tool-output.ts"
import type { AutomationEventStream } from "./event.ts"

export * as AutomationCode from "./code.ts"

export const TIMEOUT_MS = 30_000
export const MAX_TOOL_CALLS = 20
export const MAX_OUTPUT_BYTES = 32 * 1024

const CODE_LIMITS: CodeModeSchema.ExecutionLimits = {
  timeoutMs: TIMEOUT_MS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxLogBytes: MAX_OUTPUT_BYTES,
}

const FORBIDDEN_TOOLS = new Set([
  "shell",
  "vibest.automation_create",
  "vibest.automation_pause",
  "vibest.automation_resume",
  "vibest.automation_remove",
  "vibest.automation_delete",
  "vibest.automation_runNow",
])

const ALLOWED_AUTOMATION_READS = new Set(["vibest.automation_list", "vibest.automation_get"])

const isForbiddenTool = (path: string): boolean =>
  !ALLOWED_AUTOMATION_READS.has(path) &&
  (FORBIDDEN_TOOLS.has(path) || path.startsWith("automation.") || path.includes(".automation_"))

export const allowTool = (path: string): Result.Result<void, string> =>
  isForbiddenTool(path) ? Result.fail(`Tool ${path} cannot be used inside an automation`) : Result.succeed(undefined)

export const validateCode = (codemode: CodeMode.Interface, code: string): Result.Result<void, string> => {
  if (code.trim().length === 0) return Result.fail("Automation code must not be empty")

  return codemode.checkSyntax(code)
}

export const boundedOutput = (text: string): string => ToolOutput.truncateInline(text, MAX_OUTPUT_BYTES)

export const handoffOutput = (delivery: string, logs?: string): string =>
  boundedOutput(logs === undefined ? delivery : `${delivery}\n${logs}`)

export interface RunCaller {
  readonly sessionId: string
  readonly projectId: string
}

export interface RunInput {
  readonly state: Schema.Json | null
  readonly now: number
  readonly runs: number
  readonly caller?: RunCaller | undefined
  readonly event?: ReturnType<typeof AutomationEventStream.input> | undefined
}

export type Outcome =
  | (Automation.CodeResult & { readonly ok: true; readonly output?: string | undefined })
  | {
      readonly ok: false
      readonly error: string
      readonly output?: string | undefined
      readonly invalid?: boolean | undefined
    }

export const run = Effect.fn("AutomationCode.run")(function* (
  codemode: CodeMode.Interface,
  directory: string,
  action: Automation.CodeAction,
  input: RunInput,
): Effect.fn.Return<Outcome> {
  const valid = validateCode(codemode, action.code)

  if (Result.isFailure(valid)) {
    return { ok: false, error: valid.failure, invalid: true }
  }

  const payload: Schema.JsonObject = {
    state: input.state,
    now: input.now,
    runs: input.runs,
    args: action.args ?? null,
    ...(input.event !== undefined && { event: input.event }),
  }

  const headers =
    input.caller !== undefined
      ? {
          "vibest-caller": "session",
          "vibest-session-id": input.caller.sessionId,
          "vibest-project-id": input.caller.projectId,
          "vibest-repository": directory,
        }
      : undefined

  const executed = yield* codemode
    .execute(
      {
        code: action.code,
        directory,
        bindings: { ...payload, input: payload },
        limits: CODE_LIMITS,
      },
      { allowTool, ...(headers !== undefined && { headers }) },
    )
    .pipe(Effect.timeoutOption(TIMEOUT_MS))

  if (Option.isNone(executed)) {
    return { ok: false, error: `Timed out after ${TIMEOUT_MS}ms` }
  }

  const result = executed.value
  const output = result.logs.length > 0 ? boundedOutput(result.logs.join("\n")) : undefined

  if (!result.ok) {
    const invalid = result.error.kind === "ParseError" || result.error.kind === "ToolDenied"

    return {
      ok: false,
      error: result.error.message,
      ...(output !== undefined && { output }),
      ...(invalid && { invalid: true }),
    }
  }

  const decoded = Automation.decodeCodeResult(result.value ?? null)

  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      error: `An automation must return nothing or { state?, done?, send? }: ${decoded.failure}`,
      ...(output !== undefined && { output }),
      invalid: true,
    }
  }

  return {
    ok: true,
    ...(decoded.success !== null && decoded.success),
    ...(output !== undefined && { output }),
  }
})
