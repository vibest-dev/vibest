import { Automation } from "@vibest/schema/automation"
import { messageOf } from "@vibest/schema/error"
import { Clock, Effect, Result } from "effect"

import type { CodeMode } from "../codemode.ts"
import type { Session } from "../session.ts"
import { ToolOutput } from "../tool-output.ts"
import { AutomationCode, type WebhookInput } from "./code.ts"
import { AutomationEventStream } from "./event.ts"
import { followingSlot, isFinished } from "./schedule.ts"
import { type AutomationRow, toInfo } from "./sql.ts"
import type { AutomationStore } from "./store.ts"

const MINUTE = 60_000
export const LATE_AFTER = MINUTE
export const FAILED_RETRY = 5 * MINUTE
const CODE_FAILED_RETRY = MINUTE
export const MAX_CODE_FAILURES = 3
const MAX_EVENT_PROMPT_BYTES = 32_768

const deliverySummary = (sessionId: string, spawned: boolean): string =>
  `${spawned ? "Started agent session" : "Sent prompt to"} ${sessionId}`

export interface ExecuteDeps {
  readonly store: AutomationStore.Interface
  readonly codemode: CodeMode.Interface
  readonly sessions: Session.Interface
}

export interface ExecuteOptions {
  readonly event?: AutomationEventStream.Message | undefined
  readonly webhook?: WebhookInput | undefined
  readonly dedupKey?: string | undefined
  readonly manual?: boolean | undefined
}

export const createExecutor = ({ store, codemode, sessions }: ExecuteDeps) => {
  const pauseQuiet = (
    id: Automation.ID,
    details?: {
      readonly reason?: string | undefined
      readonly lastOutcome?: Automation.Outcome | undefined
      readonly lastRunAt?: number | undefined
      readonly failures?: number | undefined
    },
  ) =>
    store.pause(id, details).pipe(
      Effect.asVoid,
      Effect.catchTag("AutomationNotFoundError", () => Effect.void),
    )

  const deliverPrompt = Effect.fn("Automation.deliverPrompt")(function* (
    info: Automation.Info,
    promptText: string,
    target: Automation.Target | undefined,
    run: number,
  ): Effect.fn.Return<string, Automation.InvalidError> {
    const resolved =
      target ??
      info.action.to ??
      (info.sessionId !== undefined ? ({ sessionId: info.sessionId } satisfies Automation.Target) : undefined)

    if (resolved === undefined) {
      return yield* new Automation.InvalidError({
        message: "Automation delivery requires a target sessionId, target agent, or creating sessionId",
      })
    }

    const requestId = `aut:${info.id}:${run}`

    if ("sessionId" in resolved) {
      yield* sessions
        .send(resolved.sessionId, promptText, { type: "vibest" }, requestId)
        .pipe(Effect.mapError((error) => new Automation.InvalidError({ message: messageOf(error) })))

      return deliverySummary(resolved.sessionId, false)
    }

    const spawned = yield* sessions
      .spawn({
        machine: { id: "local" },
        root: info.directory,
        projectId: info.projectId,
        name: info.name,
        prompt: promptText,
        agent: resolved.agent,
        ...(info.sessionId !== undefined && { parentSessionId: info.sessionId }),
        request: requestId,
      })
      .pipe(Effect.mapError((error) => new Automation.InvalidError({ message: messageOf(error) })))

    return deliverySummary(spawned.id, true)
  })

  const advanceFields = (
    info: Automation.Info,
    ended: number,
    done: boolean,
    event?: AutomationEventStream.Message,
  ) => {
    if (event !== undefined) {
      return {
        status: done ? ("done" as const) : ("active" as const),
        cursor: event.cursor,
        lastEventId: event.eventId,
      }
    }

    if (info.trigger.type === "webhook") {
      return {
        status: done ? ("done" as const) : ("active" as const),
      }
    }

    const next = followingSlot(info.trigger, info.tz, info.nextDueAt ?? null, ended)
    const completed = done || isFinished(info.expiresAt ?? null, next)

    return {
      status: completed ? ("done" as const) : ("active" as const),
      nextDueAt: completed ? null : (next ?? null),
    }
  }

  const recordCodeFailure = Effect.fn("Automation.recordCodeFailure")(function* (
    info: Automation.Info,
    now: number,
    outcome: Extract<AutomationCode.Outcome, { readonly ok: false }>,
  ) {
    const ended = yield* Clock.currentTimeMillis
    const strikes = info.failures + 1
    const reason = outcome.output === undefined ? outcome.error : `${outcome.error}\n${outcome.output}`
    const formatOutput = (prefix = "") => AutomationCode.boundedOutput(prefix + reason)

    if (info.trigger.type === "event") {
      yield* pauseQuiet(info.id, {
        reason: formatOutput(),
        lastOutcome: "failed",
        lastRunAt: now,
        failures: strikes,
      })

      return
    }

    if (!outcome.invalid && strikes < MAX_CODE_FAILURES && info.trigger.type !== "webhook") {
      yield* store.recordTriggered({
        automationId: info.id,
        status: "active",
        runCount: info.runCount,
        failures: strikes,
        retryAt: ended + CODE_FAILED_RETRY,
        lastRunAt: now,
        lastOutcome: "failed",
        lastOutput: formatOutput(),
      })

      return
    }

    yield* pauseQuiet(info.id, {
      reason: formatOutput(outcome.invalid ? "Paused: " : `Paused after ${strikes} failed runs: `),
      lastOutcome: "failed",
      lastRunAt: now,
      failures: strikes,
    })
  })

  const executeRow = Effect.fn("Automation.executeRow")(function* (
    row: AutomationRow,
    now: number,
    options?: ExecuteOptions,
  ) {
    const info = toInfo(row)
    const run = info.runCount + 1
    const dueAt = info.nextDueAt ?? now

    const late =
      !options?.manual && options?.event === undefined && options?.webhook === undefined && now - dueAt >= LATE_AFTER

    const outcomeTag: Automation.Outcome = late ? "late" : "fired"

    if (info.action.type === "prompt") {
      const promptText = options?.event
        ? AutomationEventStream.prompt(info.action.prompt, options.event)
        : info.action.prompt

      if (options?.event && ToolOutput.utf8ByteLength(promptText) > MAX_EVENT_PROMPT_BYTES) {
        yield* pauseQuiet(info.id, {
          reason: "Event prompt exceeds 32 KiB",
          lastOutcome: "failed",
          lastRunAt: now,
        })

        return
      }

      const delivered = yield* Effect.result(deliverPrompt(info, promptText, info.action.to, run))

      if (Result.isFailure(delivered)) {
        yield* pauseQuiet(info.id, {
          reason: delivered.failure.message,
          lastOutcome: "failed",
          lastRunAt: now,
        })

        return
      }

      const ended = yield* Clock.currentTimeMillis
      const next = options?.manual ? { status: info.status } : advanceFields(info, ended, false, options?.event)

      yield* store.recordTriggered({
        automationId: info.id,
        runCount: run,
        failures: 0,
        retryAt: null,
        lastRunAt: now,
        lastOutcome: outcomeTag,
        lastOutput: delivered.success,
        ...(options?.dedupKey !== undefined && { dedupKey: options.dedupKey }),
        ...next,
      })

      return
    }

    const codeOutcome = yield* AutomationCode.run(codemode, row.directory, info.action, {
      state: info.state ?? null,
      now,
      runs: info.runCount,
      ...(row.sessionId !== null && { caller: { sessionId: row.sessionId, projectId: row.projectId } }),
      ...(options?.event !== undefined && { event: AutomationEventStream.input(options.event) }),
      ...(options?.webhook !== undefined && { webhook: options.webhook }),
    })

    if (!codeOutcome.ok) {
      yield* recordCodeFailure(info, now, codeOutcome)

      return
    }

    const send = codeOutcome.send
    let finalOutput: string | null = codeOutcome.output ?? null

    if (send !== undefined) {
      const delivered = yield* Effect.result(deliverPrompt(info, send.prompt, send.to, run))

      if (Result.isFailure(delivered)) {
        yield* recordCodeFailure(info, now, {
          ok: false,
          error: delivered.failure.message,
          output: codeOutcome.output,
          invalid: true,
        })

        return
      }

      finalOutput = AutomationCode.handoffOutput(delivered.success, codeOutcome.output)
    }

    const ended = yield* Clock.currentTimeMillis
    const done = codeOutcome.done === true

    const next = options?.manual
      ? { status: done ? ("done" as const) : info.status }
      : advanceFields(info, ended, done, options?.event)

    yield* store.recordTriggered({
      automationId: info.id,
      runCount: run,
      failures: 0,
      retryAt: null,
      lastRunAt: now,
      lastOutcome: outcomeTag,
      lastOutput: finalOutput,
      ...(codeOutcome.state !== undefined && { state: codeOutcome.state }),
      ...(options?.dedupKey !== undefined && { dedupKey: options.dedupKey }),
      ...next,
    })
  })

  return { pauseQuiet, executeRow }
}
