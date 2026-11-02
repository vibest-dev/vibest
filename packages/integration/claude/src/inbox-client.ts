/**
 * Claude coordinator inbox client. The CLI and RPC that produce these replies are separate.
 * plugin.ts binds it to the native hooks module and `/vibest-reattach`.
 *
 * NOT DONE: detach, pane-move recovery, and native permissions or acceptance.
 * A stored marker is not live authority after restart.
 *
 * Phase lives only in this instance. Startup calls attach with no replace; a not-reported answer leaves it new, so a
 * later start attaches again. If the server already
 * has an attachment, this instance stops until `reattach` stores a new opaque generation. It does
 * not restore another environment's phase and it does not guess that an older native submit was cancelled.
 *
 * Text from `submit` means the prompt was accepted or queued. That is not a completed VIBEST task.
 */

export type AttachReply =
  | { kind: "attached"; generation: string }
  | { kind: "stale-receiver" }
  /** The server has no reported Claude session yet and attached nothing: startup may try ordinary attach again. */
  | { kind: "not-reported" }
  | { kind: "lost" }
  | { kind: "unparsed" }

export type PullReply =
  | { kind: "claim"; token: string; file: string }
  /** A parsed pull with nothing to submit (empty, or a batch this client will not claim). */
  | { kind: "none" }
  | { kind: "stale-receiver" }
  | { kind: "lost" }
  | { kind: "unparsed" }

export type SubmitReply = { kind: "accepted"; text: string } | { kind: "drop" } | { kind: "ambiguous" }

export type SettleReply =
  | { kind: "ok" }
  | { kind: "already" }
  | { kind: "stale-receiver" }
  | { kind: "lost" }
  | { kind: "unparsed" }

export type InboxIo = {
  sessionId: () => string
  /** No replace flag. Ordinary startup is this call alone. */
  attach: (sessionId: string) => Promise<AttachReply>
  pull: (generation: string, sessionId: string) => Promise<PullReply>
  readClaim: (file: string) => Promise<string>
  submit: (text: string) => Promise<SubmitReply>
  ack: (generation: string, sessionId: string, token: string) => Promise<SettleReply>
  release: (generation: string, sessionId: string, token: string, retry: boolean) => Promise<SettleReply>
}

export type Phase =
  | "new"
  | "idle"
  | "holding"
  | "submitted"
  | "settle-ack"
  | "settle-release-retry"
  | "settle-release-fail"
  | "done"
  | "stopped"

export type StopReason = "stale-receiver" | "session-mismatch" | "attach-failed"

export type InboxSnapshot = {
  phase: Phase
  generation: string | undefined
  token: string | undefined
  busy: boolean
  stopReason: StopReason | undefined
  /** Delivery acceptance only. Never means the VIBEST task completed. */
  deliveryAccepted: boolean
}

export type ClaudeInboxClient = {
  start: () => Promise<InboxSnapshot>
  tick: () => Promise<InboxSnapshot>
  /** Store a generation minted by `/vibest-reattach` (attach --replace). Does not call attach. */
  reattach: (generation: string) => InboxSnapshot
  snapshot: () => InboxSnapshot
}

type Attempt = { epoch: number; generation: string; sessionId: string; token: string }
type Settlement = "ack" | "release-retry" | "release-fail"

const settlement = (phase: Phase): Settlement | undefined => {
  if (phase === "settle-ack") return "ack"
  if (phase === "settle-release-retry") return "release-retry"
  if (phase === "settle-release-fail") return "release-fail"
  return undefined
}

export const createClaudeInboxClient = (io: InboxIo): ClaudeInboxClient => {
  let phase: Phase = "new"
  let generation: string | undefined
  let boundSession: string | undefined
  let token: string | undefined
  let file: string | undefined
  let stopReason: StopReason | undefined
  let deliveryAccepted = false
  let epoch = 1
  let owner = 0
  let attachStarted = false

  const snapshot = (): InboxSnapshot => ({
    phase,
    generation,
    token,
    busy: owner !== 0,
    stopReason,
    deliveryAccepted,
  })

  const stop = (reason: StopReason) => {
    phase = "stopped"
    stopReason = reason
  }

  const sessionMatches = () => boundSession !== undefined && io.sessionId() === boundSession

  const foreignSession = (): boolean => {
    if (sessionMatches()) return false
    stop("session-mismatch")
    return true
  }

  const live = (attempt: Attempt) =>
    attempt.epoch === epoch && attempt.generation === generation && attempt.token === token && phase !== "stopped"

  const start = async (): Promise<InboxSnapshot> => {
    if (attachStarted) return snapshot()
    attachStarted = true
    const seen = epoch
    const sessionId = io.sessionId()
    boundSession = sessionId
    let reply: AttachReply
    try {
      reply = await io.attach(sessionId)
    } catch {
      reply = { kind: "lost" }
    }
    if (seen !== epoch) return snapshot()
    if (reply.kind === "attached") {
      generation = reply.generation
      phase = "idle"
      return snapshot()
    }
    // Nothing was attached: stay new so the next start runs the same ordinary attach. Every other reply is final.
    if (reply.kind === "not-reported") {
      attachStarted = false
      return snapshot()
    }
    stop(reply.kind === "stale-receiver" ? "stale-receiver" : "attach-failed")
    return snapshot()
  }

  const reattach = (nextGeneration: string): InboxSnapshot => {
    // The current generation is not a new receiver. Resetting it would submit the live token again.
    if (nextGeneration === generation) return snapshot()
    epoch += 1
    // The in-flight submit no longer owns busy, so it cannot clear the next tick.
    owner = 0
    attachStarted = true
    generation = nextGeneration
    boundSession = io.sessionId()
    token = undefined
    file = undefined
    deliveryAccepted = false
    stopReason = undefined
    phase = "idle"
    return snapshot()
  }

  const settle = async (attempt: Attempt) => {
    const op = settlement(phase)
    if (op === undefined || !live(attempt) || foreignSession()) return
    let reply: SettleReply
    try {
      reply =
        op === "ack"
          ? await io.ack(attempt.generation, attempt.sessionId, attempt.token)
          : await io.release(attempt.generation, attempt.sessionId, attempt.token, op === "release-retry")
    } catch {
      return
    }
    if (!live(attempt) || settlement(phase) !== op || foreignSession()) return
    if (reply.kind === "ok" || reply.kind === "already") {
      phase = "done"
      token = undefined
      file = undefined
      return
    }
    if (reply.kind === "stale-receiver") stop("stale-receiver")
  }

  const pull = async (seen: number) => {
    if (generation === undefined || boundSession === undefined) return
    const pullGeneration = generation
    const pullSession = boundSession
    let reply: PullReply
    try {
      reply = await io.pull(pullGeneration, pullSession)
    } catch {
      if (seen === epoch) foreignSession()
      return
    }
    if (seen !== epoch || generation !== pullGeneration || foreignSession()) return
    if (reply.kind === "stale-receiver") {
      stop("stale-receiver")
      return
    }
    if (reply.kind !== "claim") return
    token = reply.token
    file = reply.file
    phase = "holding"
  }

  const consume = async (seen: number) => {
    if (token === undefined || file === undefined || generation === undefined || boundSession === undefined) return
    const attempt: Attempt = { epoch: seen, generation, sessionId: boundSession, token }
    let text: string | undefined
    try {
      text = await io.readClaim(file)
    } catch {
      text = undefined
    }
    if (!live(attempt) || foreignSession()) return
    if (text === undefined || text === "") {
      phase = "settle-release-fail"
      await settle(attempt)
      return
    }
    // Holding becomes submitted before the await, so this token is never submitted twice.
    phase = "submitted"
    let submitted: SubmitReply
    try {
      submitted = await io.submit(text)
    } catch {
      submitted = { kind: "ambiguous" }
    }
    if (!live(attempt) || foreignSession()) return
    if (submitted.kind === "accepted") {
      deliveryAccepted = true
      phase = "settle-ack"
    } else if (submitted.kind === "drop") {
      phase = "settle-release-retry"
    } else {
      phase = "settle-release-fail"
    }
    await settle(attempt)
  }

  const tick = async (): Promise<InboxSnapshot> => {
    if (owner !== 0 || phase === "new" || phase === "stopped") return snapshot()
    const seen = epoch
    owner = seen
    try {
      if (!foreignSession()) {
        if (
          settlement(phase) !== undefined &&
          generation !== undefined &&
          token !== undefined &&
          boundSession !== undefined
        ) {
          await settle({ epoch: seen, generation, sessionId: boundSession, token })
        } else if (phase === "idle" || phase === "done" || phase === "holding") {
          if (phase === "done") {
            phase = "idle"
            deliveryAccepted = false
          }
          if (phase === "idle") await pull(seen)
          if (seen === epoch && phase === "holding") await consume(seen)
        }
      }
    } finally {
      if (owner === seen) owner = 0
    }
    return snapshot()
  }

  return { start, tick, reattach, snapshot }
}
