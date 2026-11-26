import { Automation } from "@vibest/schema/automation"
import { messageOf } from "@vibest/schema/error"
import { Clock, Effect, Result } from "effect"

import type { CodeMode } from "../codemode.ts"
import type { Session } from "../session.ts"
import { ToolOutput } from "../tool-output.ts"
import { AutomationCode } from "./code.ts"
import { AutomationEventStream } from "./event.ts"
import { followingSlot, isFinished } from "./schedule.ts"
import { type AutomationRow, parseEventPosition, type SettlePatch, toInfo } from "./sql.ts"
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
  readonly manual?: boolean | undefined
}

interface DeliveryOutcome {
  readonly summary: string
  readonly messageId: string
}

export const createExecutor = ({ store, codemode, sessions }: ExecuteDeps) => {
  const pauseWith = (
    row: AutomationRow,
    now: number,
    reason: string,
    extra?: Pick<SettlePatch, "failures" | "lastRunAt">,
  ) =>
    store.settle(
      row,
      {
        status: "paused",
        lastOutcome: "failed",
        lastOutput: reason,
        retryAt: null,
        timeUpdated: now,
        ...extra,
      },
      { evenIfPaused: true },
    )

  const resolveTarget = (info: Automation.Info, target: Automation.Target | undefined): Automation.Target | undefined =>
    target ??
    info.action.to ??
    (info.sessionId !== undefined ? ({ sessionId: info.sessionId } satisfies Automation.Target) : undefined)

  const deliverPrompt = Effect.fn("Automation.deliverPrompt")(function* (
    info: Automation.Info,
    promptText: string,
    target: Automation.Target | undefined,
    run: number,
    isCodeAction: boolean,
  ): Effect.fn.Return<DeliveryOutcome, Automation.InvalidError> {
    const resolved = resolveTarget(info, target)

    if (resolved === undefined) {
      return yield* new Automation.InvalidError({
        message: "Automation delivery requires a target sessionId, target agent, or creating sessionId",
      })
    }

    const messageId = isCodeAction ? `aut:${info.id}:${run}:send` : `aut:${info.id}:${run}`

    if ("sessionId" in resolved) {
      yield* sessions
        .send(resolved.sessionId, promptText, { type: "vibest" }, messageId)
        .pipe(Effect.mapError((error) => new Automation.InvalidError({ message: messageOf(error) })))

      return { summary: deliverySummary(resolved.sessionId, false), messageId }
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
        request: messageId,
      })
      .pipe(Effect.mapError((error) => new Automation.InvalidError({ message: messageOf(error) })))

    return { summary: deliverySummary(spawned.id, true), messageId }
  })

  const advancePatch = (
    row: AutomationRow,
    info: Automation.Info,
    ended: number,
    done: boolean,
    event?: AutomationEventStream.Message,
  ): SettlePatch => {
    if (event !== undefined) {
      const currentEventPos = parseEventPosition(row.eventPosition)

      return {
        ...(done && { status: "done" }),
        eventPosition: {
          ...currentEventPos,
          cursor: event.cursor,
          id: event.eventId,
        },
      }
    }

    const next = followingSlot(info.trigger, info.tz, row.nextDueAt, ended)
    const completed = done || isFinished(row.expiresAt, next)

    return completed ? { status: "done", nextDueAt: null } : { nextDueAt: next ?? null }
  }

  const recordCodeFailure = Effect.fn("Automation.recordCodeFailure")(function* (
    row: AutomationRow,
    info: Automation.Info,
    now: number,
    outcome: Extract<AutomationCode.Outcome, { readonly ok: false }>,
    manual: boolean,
  ) {
    const ended = yield* Clock.currentTimeMillis
    const strikes = row.failures + 1
    const reason = outcome.output === undefined ? outcome.error : `${outcome.error}\n${outcome.output}`
    const formatOutput = (prefix = "") => AutomationCode.boundedOutput(prefix + reason)

    if (info.trigger.type === "event") {
      yield* pauseWith(row, now, formatOutput(), { failures: strikes, lastRunAt: now })

      return
    }

    if (!outcome.invalid && strikes < MAX_CODE_FAILURES) {
      const keepPaused = manual || row.status === "paused"

      yield* store.settle(
        row,
        {
          failures: strikes,
          lastRunAt: now,
          lastOutcome: "failed",
          lastOutput: formatOutput(),
          ...(row.status === "active" && !manual && { retryAt: ended + CODE_FAILED_RETRY }),
          timeUpdated: ended,
        },
        keepPaused ? { evenIfPaused: true } : undefined,
      )

      return
    }

    yield* store.settle(
      row,
      {
        status: "paused",
        failures: strikes,
        lastRunAt: now,
        lastOutcome: "failed",
        lastOutput: formatOutput(outcome.invalid ? "Paused: " : `Paused after ${strikes} failed runs: `),
        retryAt: null,
        timeUpdated: ended,
      },
      { evenIfPaused: true },
    )
  })

  const executeRow = Effect.fn("Automation.executeRow")(function* (
    row: AutomationRow,
    now: number,
    options?: ExecuteOptions,
  ) {
    const info = toInfo(row)
    const run = row.runCount + 1
    const dueAt = row.nextDueAt ?? now
    const late = !options?.manual && options?.event === undefined && now - dueAt >= LATE_AFTER
    const outcomeTag: Automation.Outcome = late ? "late" : "fired"

    if (info.action.type === "prompt") {
      const promptText = options?.event
        ? AutomationEventStream.prompt(info.action.prompt, options.event)
        : info.action.prompt

      if (options?.event && ToolOutput.utf8ByteLength(promptText) > MAX_EVENT_PROMPT_BYTES) {
        yield* pauseWith(row, now, "Event prompt exceeds 32 KiB", { lastRunAt: now })

        return
      }

      const resolved = resolveTarget(info, info.action.to)

      if (
        !options?.event &&
        !options?.manual &&
        resolved !== undefined &&
        "sessionId" in resolved &&
        row.lastMessageId !== null &&
        (yield* store.hasPendingInboxMessage(resolved.sessionId, row.lastMessageId))
      ) {
        const ended = yield* Clock.currentTimeMillis

        yield* store.settle(row, {
          lastOutcome: "skipped",
          retryAt: null,
          ...advancePatch(row, info, ended, false),
          timeUpdated: now,
        })

        return
      }

      const delivered = yield* Effect.result(deliverPrompt(info, promptText, info.action.to, run, false))

      if (Result.isFailure(delivered)) {
        yield* pauseWith(row, now, delivered.failure.message, { lastRunAt: now })

        return
      }

      const ended = yield* Clock.currentTimeMillis
      const next: SettlePatch = options?.manual ? {} : advancePatch(row, info, ended, false, options?.event)

      yield* store.settle(
        row,
        {
          runCount: run,
          failures: 0,
          retryAt: null,
          lastRunAt: now,
          lastMessageId: delivered.success.messageId,
          lastOutcome: outcomeTag,
          lastOutput: delivered.success.summary,
          timeUpdated: now,
          ...next,
        },
        { evenIfPaused: true },
      )

      return
    }

    const codeOutcome = yield* AutomationCode.run(codemode, row.directory, info.action, {
      state: info.state ?? null,
      now,
      runs: row.runCount,
      ...(row.sessionId !== null && { caller: { sessionId: row.sessionId, projectId: row.projectId } }),
      ...(options?.event !== undefined && { event: AutomationEventStream.input(options.event) }),
    })

    if (!codeOutcome.ok) {
      yield* recordCodeFailure(row, info, now, codeOutcome, options?.manual === true)

      return
    }

    const send = codeOutcome.send
    let finalOutput: string | null = codeOutcome.output ?? null
    let lastMessageId: string | undefined

    if (send !== undefined) {
      const delivered = yield* Effect.result(deliverPrompt(info, send.prompt, send.to, run, true))

      if (Result.isFailure(delivered)) {
        yield* recordCodeFailure(
          row,
          info,
          now,
          {
            ok: false,
            error: delivered.failure.message,
            output: codeOutcome.output,
            invalid: true,
          },
          options?.manual === true,
        )

        return
      }

      finalOutput = AutomationCode.handoffOutput(delivered.success.summary, codeOutcome.output)
      lastMessageId = delivered.success.messageId
    }

    const ended = yield* Clock.currentTimeMillis
    const done = codeOutcome.done === true

    const next: SettlePatch = options?.manual
      ? done
        ? { status: "done", nextDueAt: null }
        : {}
      : advancePatch(row, info, ended, done, options?.event)

    yield* store.settle(
      row,
      {
        runCount: run,
        failures: 0,
        retryAt: null,
        lastRunAt: now,
        ...(lastMessageId !== undefined && { lastMessageId }),
        lastOutcome: outcomeTag,
        lastOutput: finalOutput,
        ...(codeOutcome.state !== undefined && { state: codeOutcome.state }),
        timeUpdated: ended,
        ...next,
      },
      { evenIfPaused: true },
    )
  })

  return { pauseWith, executeRow }
}
