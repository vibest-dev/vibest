// Maps one inbox CLI JSON reply onto the accepted client unions. No process, filesystem, or native API.
import type { AttachReply, PullReply, SettleReply } from "./inbox-client.ts"

const object = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(stdout) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

const text = (value: Record<string, unknown>, key: string) => (typeof value[key] === "string" ? value[key] : undefined)

const flag = (value: Record<string, unknown>, key: string) => value[key] === true

/** A success flag and an error, or an empty claim field, is not a reply. */
const contradictory = (value: Record<string, unknown>, success: boolean) =>
  text(value, "error") !== undefined && success

export const adaptAttach = (code: number, stdout: string): AttachReply => {
  if (code !== 0) return { kind: "lost" }
  const value = object(stdout)
  if (!value) return { kind: "unparsed" }
  const generation = text(value, "generation")
  const error = text(value, "error")
  if (generation !== undefined && generation !== "" && error === undefined && !flag(value, "empty")) return { kind: "attached", generation }
  if (error === "stale-receiver" && generation === undefined) return { kind: "stale-receiver" }
  if (error === "not-reported" && !("generation" in value)) return { kind: "not-reported" }
  return { kind: "unparsed" }
}

export const adaptPull = (code: number, stdout: string): PullReply => {
  if (code !== 0) return { kind: "lost" }
  const value = object(stdout)
  if (!value) return { kind: "unparsed" }
  const token = text(value, "token")
  const file = text(value, "file")
  const error = text(value, "error")
  const claim = token !== undefined && token !== "" && file !== undefined && file !== ""
  if (contradictory(value, claim || flag(value, "empty") || flag(value, "acked") || flag(value, "released"))) return { kind: "unparsed" }
  if (claim && error === undefined && value.empty !== true) return { kind: "claim", token: token!, file: file! }
  if (value.empty === true && !claim && error === undefined) return { kind: "none" }
  if (error === "too-large" && !claim) return { kind: "none" }
  if (error === "stale-receiver" && !claim) return { kind: "stale-receiver" }
  return { kind: "unparsed" }
}

export const adaptSettle = (code: number, stdout: string, op: "ack" | "release"): SettleReply => {
  if (code !== 0) return { kind: "lost" }
  const value = object(stdout)
  if (!value) return { kind: "unparsed" }
  const error = text(value, "error")
  const acked = value.acked === true
  const released = value.released === true
  const already = value.already === true
  if (value.acked === false || value.released === false || value.already === false) return { kind: "unparsed" }
  if (error !== undefined && (acked || released || already)) return { kind: "unparsed" }
  if (acked && released) return { kind: "unparsed" }
  const mine = op === "ack" ? acked : released
  const other = op === "ack" ? released : acked
  if (other) return { kind: "unparsed" }
  if (already && !mine) return { kind: "unparsed" }
  if (already && mine && error === undefined) return { kind: "already" }
  if (mine && error === undefined) return { kind: "ok" }
  if (error === "stale-receiver") return { kind: "stale-receiver" }
  return { kind: "unparsed" }
}
