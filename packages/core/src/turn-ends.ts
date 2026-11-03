// The turn ends and turn starts the harness integrations hand vibestd (hooks.ts), kept in memory until the session's
// next check settles them into `turn.end` events (rounds.ts collectResult). Memory only: a turn end vibestd had not
// written when it stopped is lost, and reconciliation records its turn lost (docs/design/schema.md, Memory).
import { Context, Effect, Layer } from "effect"

import type { HarnessAdapter, HarnessId } from "./harness.ts"
import { jsonObject } from "./results.ts"

/** A harness's turn end, as its integration reported it. */
export type TurnEnded = {
  readonly harness: HarnessId
  /** When vibestd received it. */
  readonly at: number
  /** The harness's answer text. */
  readonly text: string
  readonly error: string | undefined
  /** Cursor's `conversation_id` (in every hook's input), the id `--resume` takes; only a plain id, never one that reads as a flag. */
  readonly conversationId: string | undefined
  /** A turn stopped in its terminal (`aborted: true`, Claude's and Pi's): a result only for an open round. */
  readonly interrupted: boolean
}

/** The adapter's `turnEnd` reading of a hook's `raw` input, received at `at`; undefined when it is no turn end. */
export const turnEndOf = (adapter: HarnessAdapter, agent: string, raw: string, at: number): TurnEnded | undefined => {
  const event = jsonObject(raw)
  const payload = event && adapter.turnEnd?.(event, agent === "coordinator")?.result
  return payload ? turnEndFrom(adapter, payload, at) : undefined
}

/** A turn end from the adapter's result `payload` (the harness's hook input, verbatim), received at `at`. */
export const turnEndFrom = (
  adapter: HarnessAdapter,
  payload: Readonly<Record<string, unknown>>,
  at: number,
): TurnEnded => {
  const text = payload[adapter.resultField]
  const error = payload.error
  // `error` names what ended the turn (Claude's `interrupted`, `refusal`, `error`), `error_details` the text.
  const details = payload.error_details
  const conversation = payload.conversation_id
  return {
    harness: adapter.id,
    at,
    text: typeof text === "string" ? text : "",
    error:
      typeof error === "string" && error
        ? typeof details === "string" && details
          ? `${error}: ${details}`
          : error
        : undefined,
    conversationId:
      typeof conversation === "string" && /^\w[\w.:-]{0,127}$/.test(conversation) ? conversation : undefined,
    interrupted: payload.aborted === true,
  }
}

const make = Effect.sync(() => {
  /** Each session's latest turn end. */
  const ends = new Map<string, TurnEnded>()
  /** Each session's latest turn start (the user's prompt reached the harness): the pickup proof a send compares. */
  const starts = new Map<string, number>()
  return {
    ended: (id: string, end: TurnEnded) =>
      Effect.sync(() => {
        ends.set(id, end)
      }),
    latest: (id: string) => Effect.sync(() => ends.get(id)),
    /** The end `end` was written as session `id`'s result: drop it, unless a newer one replaced it meanwhile. */
    written: (id: string, end: TurnEnded) =>
      Effect.sync(() => {
        if (ends.get(id) === end) ends.delete(id)
      }),
    /** A turn end reported at or after `at` is dropped (a restart's or a move's old harness); `0`: any. */
    drop: (id: string, since = 0) =>
      Effect.sync(() => {
        if ((ends.get(id)?.at ?? -1) >= since) ends.delete(id)
      }),
    started: (id: string, at: number) =>
      Effect.sync(() => {
        if (at > (starts.get(id) ?? -1)) starts.set(id, at)
      }),
    /** Whether a turn started at or after `at`. */
    startedSince: (id: string, at: number) => Effect.sync(() => (starts.get(id) ?? -1) >= at),
    /** Forget every session `keep` rejects (the sweep: no longer live). */
    sweep: (keep: (id: string) => boolean) =>
      Effect.sync(() => {
        for (const id of ends.keys()) if (!keep(id)) ends.delete(id)
        for (const id of starts.keys()) if (!keep(id)) starts.delete(id)
      }),
    size: Effect.sync(() => ({ ends: ends.size, starts: starts.size })),
    /** Forget session `id` (archived). */
    forget: (id: string) =>
      Effect.sync(() => {
        ends.delete(id)
        starts.delete(id)
      }),
  }
})

/** One per vibestd, shared by the hooks, Sessions and its restart, move, placement and removal. */
export class TurnEnds extends Context.Service<TurnEnds, Effect.Success<typeof make>>()("vibest/TurnEnds") {
  static readonly layer = Layer.effect(TurnEnds, make)
}
