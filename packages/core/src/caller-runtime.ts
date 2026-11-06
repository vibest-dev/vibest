import type { Runtime as RuntimeApi } from "@vibest/plugin"
import { Effect, Option } from "effect"

import { type ProcessFacts, Processes, validPid } from "./processes.ts"
import { type Runtime, type Terminal } from "./runtimes.ts"

export type CallerResult =
  | { readonly status: "matched"; readonly runtime: string; readonly terminal: Terminal }
  | { readonly status: "outside" }
  | { readonly status: "unresolved"; readonly reason: string }

export interface Candidate extends RuntimeApi.CallerTerminal {
  readonly runtime: string
}

export const unresolved = (reason: string): CallerResult => ({ status: "unresolved", reason })
export const callerKeys = (runtimes: ReadonlyArray<Runtime>) =>
  [...new Set(runtimes.flatMap((r) => r.caller?.env ?? []))].sort()

export const selectCaller = (
  pid: number,
  candidates: ReadonlyArray<Candidate>,
  facts: ReadonlyArray<ProcessFacts>,
): CallerResult => {
  const processes = new Map(facts.map((p) => [p.pid, p]))
  const caller = processes.get(pid)
  if (!caller) return unresolved("caller process metadata is unavailable")
  const live = candidates.filter((c) => c.live && c.localRootPid !== undefined && processes.has(c.localRootPid))
  const sameNamespace = live.filter((c) => processes.get(c.localRootPid!)!.namespace === caller.namespace)
  const direct = sameNamespace.filter((c) => {
    const root = processes.get(c.localRootPid!)!
    if (caller.tty !== undefined && root.tty !== undefined) return caller.tty === root.tty
    return caller.session !== undefined && caller.session === root.session
  })
  const matched = (c: Candidate): CallerResult => ({ status: "matched", runtime: c.runtime, terminal: c.terminal })
  if (direct.length === 1) return matched(direct[0]!)
  if (direct.length > 1) return unresolved("several live terminals match the caller tty or session")
  const visited = new Set<number>()
  let at: ProcessFacts | undefined = caller
  for (let depth = 0; at && depth < 64 && !visited.has(at.pid); depth++) {
    visited.add(at.pid)
    const roots = sameNamespace.filter((c) => {
      const root = processes.get(c.localRootPid!)!
      return root.pid === at!.pid && !(caller.tty !== undefined && root.tty !== undefined && caller.tty !== root.tty)
    })
    if (roots.length === 1) return matched(roots[0]!)
    if (roots.length > 1) return unresolved("several live terminals share the nearest caller ancestor")
    at = processes.get(at.parent)
  }
  return unresolved(
    "no live terminal contains the caller (stale environment, another tty, or unavailable process ancestry)",
  )
}

const probe = (runtime: Runtime, env: Readonly<Record<string, string>>) =>
  runtime
    .caller!.detect(
      Object.fromEntries(runtime.caller!.env.filter((key) => env[key] !== undefined).map((key) => [key, env[key]!])),
    )
    .pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.map((result) =>
        Option.isSome(result)
          ? { candidate: result.value, reason: undefined }
          : { candidate: undefined, reason: runtime.kind + ": detector timed out" },
      ),
      Effect.catchTag("RuntimeError", (error) =>
        Effect.succeed({ candidate: undefined, reason: runtime.kind + ": detector " + error.code }),
      ),
      Effect.catchCause(() => Effect.succeed({ candidate: undefined, reason: runtime.kind + ": detector failed" })),
    )

export const detectCaller = (
  runtimes: ReadonlyArray<Runtime>,
  input: {
    readonly pid: number
    readonly env: Readonly<Record<string, string>>
    readonly keys: ReadonlyArray<string>
    readonly runtime?: string | undefined
  },
): Effect.Effect<CallerResult, never, Processes> =>
  Effect.gen(function* () {
    const keys = callerKeys(runtimes)
    if (JSON.stringify(keys) !== JSON.stringify(input.keys))
      return unresolved("runtime caller capabilities changed; retry")
    if (
      !validPid(input.pid) ||
      Object.keys(input.env).some((key) => !keys.includes(key)) ||
      Object.values(input.env).some((value) => value.length > 4096)
    )
      return unresolved("invalid caller context")
    const eligible = runtimes.filter((r) => r.caller && (input.runtime === undefined || r.kind === input.runtime))
    const seen = yield* Effect.forEach(
      eligible,
      (r) => probe(r, input.env).pipe(Effect.map((seen) => ({ ...seen, runtime: r }))),
      { concurrency: 8 },
    )
    const candidates = seen.flatMap((s) => (s.candidate ? [{ ...s.candidate, runtime: s.runtime.kind }] : []))
    const reasons = seen.flatMap((s) => (s.reason ? [s.reason] : []))
    if (candidates.length === 0) return reasons.length ? unresolved(reasons.join("; ")) : { status: "outside" }
    const processes = yield* Processes
    const facts = new Map<number, ProcessFacts>()
    const read = (pid: number) =>
      processes.inspect(pid).pipe(
        Effect.tap((p) =>
          Effect.sync(() => {
            if (p) facts.set(pid, p)
          }),
        ),
      )
    yield* Effect.forEach(
      candidates,
      (c) =>
        Effect.gen(function* () {
          if (!c.live) return
          if (!validPid(c.localRootPid)) {
            reasons.push(c.runtime + ": no local root process")
            return
          }
          if (!(yield* read(c.localRootPid)) && (yield* processes.liveness(c.localRootPid)) !== "exited")
            reasons.push(c.runtime + ": root process metadata unavailable")
        }),
      { concurrency: 8 },
    )
    let at: number = input.pid
    const visited = new Set<number>()
    for (let depth = 0; validPid(at) && depth < 64 && !visited.has(at); depth++) {
      visited.add(at)
      const known = facts.get(at)
      const p = known ?? (yield* read(at))
      if (!p || p.parent === at) break
      at = p.parent
    }
    const result = selectCaller(input.pid, candidates, [...facts.values()])
    if (result.status !== "matched")
      return result.status === "unresolved" && reasons.length
        ? unresolved(result.reason + "; " + reasons.join("; "))
        : result
    const selected = seen.find((s) => s.runtime.kind === result.runtime)!
    const before = selected.candidate!
    const root = facts.get(before.localRootPid!)!
    const caller = facts.get(input.pid)!
    const direct =
      caller.tty !== undefined && root.tty !== undefined
        ? caller.tty === root.tty
        : caller.session !== undefined && caller.session === root.session
    if (!direct && reasons.length)
      return unresolved("ancestry alone cannot exclude other caller terminals; " + reasons.join("; "))
    const checked = yield* probe(selected.runtime, input.env)
    if (
      !checked.candidate?.live ||
      checked.candidate.localRootPid !== before.localRootPid ||
      checked.candidate.terminal.id !== before.terminal.id ||
      checked.candidate.terminal.machine !== before.terminal.machine
    )
      return unresolved("caller terminal changed during detection; retry")
    for (const pid of new Set([input.pid, before.localRootPid!])) {
      const now = yield* processes.inspect(pid)
      const prior = facts.get(pid)!
      if (
        !now ||
        now.start !== prior.start ||
        now.parent !== prior.parent ||
        now.tty !== prior.tty ||
        now.session !== prior.session ||
        now.namespace !== prior.namespace
      )
        return unresolved("caller process changed during detection; retry")
    }
    return result
  })
