import { Automation } from "@vibest/schema/automation"
import { Cron, DateTime, Effect, Option, Result } from "effect"
import { Digest } from "effect/crypto"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const HMAC_BLOCK_SIZE = 64

const RELATIVE = /^in\s+(.+)$/i
const OFFSET = /\d(?:z|[+-]\d{2}:?\d{2})$/i

const encoder = new TextEncoder()

const safeEqualHex = (a: string, b: string): boolean => {
  const left = encoder.encode(a)
  const right = encoder.encode(b)

  if (left.length !== right.length) return false
  let diff = 0

  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!

  return diff === 0
}

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)

  return out
}

const hmacSha256Hex = (digest: Digest.Digest["Service"], keyText: string, messageText: string) =>
  Effect.gen(function* () {
    const rawKey = encoder.encode(keyText)
    const keyBytes = rawKey.length > HMAC_BLOCK_SIZE ? yield* digest.digest(Digest.sha256, rawKey) : rawKey
    const block = new Uint8Array(HMAC_BLOCK_SIZE)
    block.set(keyBytes, 0)

    const ipad = new Uint8Array(HMAC_BLOCK_SIZE)
    const opad = new Uint8Array(HMAC_BLOCK_SIZE)

    for (let i = 0; i < HMAC_BLOCK_SIZE; i++) {
      ipad[i] = block[i]! ^ 0x36
      opad[i] = block[i]! ^ 0x5c
    }

    const inner = yield* digest.digest(Digest.sha256, concatBytes(ipad, encoder.encode(messageText)))

    return yield* digest.digestHex(Digest.sha256, concatBytes(opad, inner))
  })

export const sha256Hex = (digest: Digest.Digest["Service"], value: string) =>
  digest.digestHex(Digest.sha256, encoder.encode(value))

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
    case "webhook":
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

      case "webhook":
      case "event":
        return undefined
    }
  })

export const computeResumeDue = (
  trigger: Automation.Trigger,
  zone: DateTime.TimeZone,
  tz: string,
  now: number,
): Effect.Effect<number | undefined, Automation.InvalidError> => {
  if (trigger.type !== "at") return computeInitialDue(trigger, zone, tz, now)
  const parsed = parseTime(trigger.at, zone, now)

  if (Option.isNone(parsed)) {
    return Effect.fail(new Automation.InvalidError({ message: `Invalid time: ${trigger.at}` }))
  }

  return Effect.succeed(Math.max(now, parsed.value))
}

export const readHeader = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  const lower = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }

  return undefined
}

export const verifyWebhookAuth = (
  digest: Digest.Digest["Service"],
  id: Automation.ID,
  trigger: Automation.WebhookTrigger,
  webhookSecret: string | undefined,
  headers: Readonly<Record<string, string>>,
  rawBody: string,
): Effect.Effect<void, Automation.WebhookUnauthorizedError> =>
  Effect.gen(function* () {
    const expectedHash =
      trigger.secretHash ?? (webhookSecret !== undefined ? yield* sha256Hex(digest, webhookSecret) : undefined)

    if (expectedHash === undefined) return

    const sigHeader = readHeader(headers, "x-vibest-signature-256") ?? readHeader(headers, "x-hub-signature-256")

    if (sigHeader !== undefined && webhookSecret !== undefined) {
      const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice("sha256=".length) : sigHeader
      const expectedSig = yield* hmacSha256Hex(digest, webhookSecret, rawBody)

      if (safeEqualHex(provided.toLowerCase(), expectedSig.toLowerCase())) return
    }

    const authHeader = readHeader(headers, "authorization")

    if (authHeader !== undefined && /^bearer\s+/i.test(authHeader)) {
      const token = authHeader.replace(/^bearer\s+/i, "").trim()
      const tokenHash = yield* sha256Hex(digest, token)

      if (safeEqualHex(tokenHash, expectedHash)) {
        return
      }
    }

    return yield* new Automation.WebhookUnauthorizedError({
      automationId: id,
      message: "Invalid or missing webhook signature or bearer secret",
    })
  })
