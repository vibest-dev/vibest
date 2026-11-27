import { Automation } from "@vibest/schema/automation"
import { Cron, DateTime, Effect, Option, Result } from "effect"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const RELATIVE = /^in\s+(.+)$/i
const OFFSET = /\d(?:z|[+-]\d{2}:?\d{2})$/i

export const resolveZone = (tz?: string): Effect.Effect<DateTime.TimeZone, Automation.InvalidError> => {
  const name = tz?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const zone = DateTime.zoneMakeNamed(name)

  return Option.isSome(zone)
    ? Effect.succeed(zone.value)
    : Effect.fail(new Automation.InvalidError({ message: `Invalid time zone: ${name}` }))
}

export const parseTime = (raw: string, zone: DateTime.TimeZone, now: number): Option.Option<number> => {
  const input = raw.trim()
  const relative = RELATIVE.exec(input)

  if (relative?.[1] !== undefined) {
    return Option.flatMap(Automation.durationMillis(relative[1]), (delay) =>
      delay > 0 ? Option.some(now + delay) : Option.none(),
    )
  }

  return Option.map(
    OFFSET.test(input) ? DateTime.make(input) : DateTime.makeZoned(input, { timeZone: zone, adjustForTimeZone: true }),
    DateTime.toEpochMillis,
  )
}

const cronNext = Option.liftThrowable(Cron.next)

export const nextCron = (cron: Cron.Cron, now: number, from = now): number | undefined => {
  const next = cronNext(cron, new Date(from))

  if (Option.isNone(next)) return undefined
  const at = next.value.getTime()

  return at > now ? at : nextCron(cron, now, at + HOUR)
}

const parseDurationMillis = (value: string): Effect.Effect<number, Automation.InvalidError> =>
  Option.match(Automation.durationMillis(value), {
    onNone: () => Effect.fail(new Automation.InvalidError({ message: `Invalid duration: ${value}` })),
    onSome: (millis) =>
      millis > 0
        ? Effect.succeed(millis)
        : Effect.fail(new Automation.InvalidError({ message: `Duration must be positive: ${value}` })),
  })

const parseCronExpr = (expr: string, tz: string): Effect.Effect<Cron.Cron, Automation.InvalidError> =>
  Result.match(Cron.parse(expr, tz), {
    onFailure: (error) =>
      Effect.fail(new Automation.InvalidError({ message: `Invalid cron expression "${expr}": ${error.message}` })),
    onSuccess: Effect.succeed,
  })

const storedMillis = (value: string): number =>
  Option.getOrThrowWith(Automation.durationMillis(value), () => new Error(`Invalid duration: ${value}`))

export const followingSlot = (
  trigger: Automation.Trigger,
  tz: string,
  nextDueAt: number | null,
  now: number,
): number | undefined => {
  switch (trigger.type) {
    case "at":
    case "event":
      return undefined

    case "every": {
      const every = storedMillis(trigger.every)
      const due = nextDueAt ?? now

      return due + (Math.floor((now - due) / every) + 1) * every
    }

    case "cron":
      return nextCron(Cron.parseUnsafe(trigger.cron, tz), now)
  }
}

export const isFinished = (expiresAt: number | null, next: number | undefined): boolean =>
  next === undefined || (expiresAt !== null && next > expiresAt)

export const isExpired = (expiresAt: number | null, now: number): boolean => expiresAt !== null && now > expiresAt

export const isRelativeAt = (raw: string): boolean => RELATIVE.test(raw.trim())

export const freezeAtTrigger = (trigger: Automation.Trigger, nextDueAt: number | undefined): Automation.Trigger =>
  trigger.type === "at" && nextDueAt !== undefined && isRelativeAt(trigger.at)
    ? {
        type: "at",
        at: new Date(nextDueAt).toISOString(),
        ...(trigger.tz !== undefined && { tz: trigger.tz }),
      }
    : trigger

export const computeInitialDue = (
  trigger: Automation.Trigger,
  zone: DateTime.TimeZone,
  tz: string,
  now: number,
): Effect.Effect<number | undefined, Automation.InvalidError> =>
  Effect.gen(function* () {
    switch (trigger.type) {
      case "at": {
        const parsed = parseTime(trigger.at, zone, now)

        if (Option.isNone(parsed)) {
          return yield* new Automation.InvalidError({ message: `Invalid time: ${trigger.at}` })
        }

        if (parsed.value <= now) {
          return yield* new Automation.InvalidError({ message: `Scheduled time must be in the future: ${trigger.at}` })
        }

        return parsed.value
      }

      case "every": {
        const every = yield* parseDurationMillis(trigger.every)

        return now + every
      }

      case "cron": {
        const cron = yield* parseCronExpr(trigger.cron, tz)
        const next = nextCron(cron, now)

        if (next === undefined) {
          return yield* new Automation.InvalidError({
            message: `Cron expression never matches a future time: ${trigger.cron}`,
          })
        }

        return next
      }

      case "event":
        return undefined
    }
  })

export const computeResumeDue = (
  trigger: Automation.Trigger,
  tz: string,
  currentNextDueAt: number | null,
  now: number,
): number | null => {
  if (trigger.type === "event") return null

  if (currentNextDueAt === null || currentNextDueAt > now) return currentNextDueAt

  return followingSlot(trigger, tz, currentNextDueAt, now) ?? currentNextDueAt
}
