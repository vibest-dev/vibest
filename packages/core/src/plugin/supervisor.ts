import { Cause, Duration, Effect, Queue, Semaphore, Stream } from "effect"

import { logFailure } from "../reactor.ts"
import { type Candidate, keyOf, makeSources, makeWatcher, type Operation } from "./sources.ts"

export const DEBOUNCE = Duration.millis(100)
export const RECHECK = Duration.seconds(1)

type Sources = Effect.Success<ReturnType<typeof makeSources>>

interface Host {
  readonly activate: (candidates: ReadonlyArray<Candidate>) => Effect.Effect<void>
  readonly holdNow: () => Effect.Effect<void>
  readonly importing: (sources: ReadonlyArray<string>) => Effect.Effect<void>
}

const named = (candidate: Candidate): string => ("error" in candidate.plugin ? candidate.source : candidate.plugin.id)

const matches = (selector: string, id: string) =>
  selector === "*" || (selector.endsWith(".*") ? id.startsWith(selector.slice(0, -1)) : selector === id)

const isBuiltin = (candidate: Candidate) => candidate.source.startsWith("builtin:")

const removeMatching = (candidates: Array<Candidate>, target: string) => {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!
    const p = candidate.plugin
    if (isBuiltin(candidate) ? "id" in p && target === p.id : "error" in p ? target === "*" : matches(target, p.id))
      candidates.splice(i, 1)
  }
}

export const keptBuiltins = (builtins: ReadonlyArray<Candidate>, operations: ReadonlyArray<Operation>) => {
  const kept = [...builtins]
  for (const op of operations) if (op.type === "remove") removeMatching(kept, op.target)
  return kept
}

export const resolve = Effect.fnUntraced(function* (
  sources: Sources,
  builtins: ReadonlyArray<Candidate> = [],
  note: (sources: ReadonlyArray<string>) => Effect.Effect<void> = () => Effect.void,
) {
  const { operations, watched } = yield* sources.operations
  const loading = operations.flatMap((op) => (op.type === "add" ? [op.target] : []))
  yield* note([...loading])
  const candidates: Array<Candidate> = [...builtins]
  for (const op of operations) {
    if (op.type === "remove") {
      removeMatching(candidates, op.target)
      continue
    }
    const candidate = yield* sources.load(op, watched)
    const at = loading.indexOf(op.target)
    if (at !== -1) {
      if (candidate === undefined) loading.splice(at, 1)
      else loading[at] = named(candidate)
      yield* note([...loading])
    }
    if (candidate === undefined) continue
    const same = candidates.findIndex((c) => c.source === candidate.source)
    if (same === -1) candidates.push(candidate)
    else candidates[same] = candidate
  }
  yield* sources.retain(watched.paths)
  return { candidates, watched }
})

export const supervise = Effect.fnUntraced(function* (
  host: Host,
  builtins: ReadonlyArray<Candidate>,
  sources: Sources,
) {
  const triggers = yield* Queue.sliding<number>(1)
  const builtinTriggers = yield* Queue.sliding<void>(1)
  const changed = new Set<string>()
  let observed = 0
  let release: Effect.Effect<void> | undefined = host.holdNow()
  const notify = (file?: string) => {
    if (file !== undefined) changed.add(file)
    observed++
    if (release === undefined) release = host.holdNow()
    Queue.offerUnsafe(triggers, observed)
    Queue.offerUnsafe(builtinTriggers, undefined)
  }
  const watcher = yield* makeWatcher(notify)
  const lock = yield* Semaphore.make(1)
  let users: ReadonlyArray<Candidate> = []
  let activated: string | undefined
  const publish = (next?: ReadonlyArray<Candidate>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (next !== undefined) users = next
        const { operations } = yield* sources.operations
        const candidates = [...keptBuiltins(builtins, operations), ...users]
        const revisions = candidates.map(keyOf).join("\n")
        if (revisions === activated) return
        yield* host.activate(candidates)
        activated = revisions
      }),
    )
  yield* publish().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("failed to activate plugins", cause),
    ),
  )
  yield* Stream.fromQueue(builtinTriggers).pipe(
    Stream.runForEach(() => publish().pipe(logFailure("plugins: builtin update failed"))),
    Effect.forkScoped,
  )
  let reloading = false
  const reload = Effect.gen(function* () {
    if (changed.size > 0) yield* Effect.log(`plugins: reloading after changes to ${[...changed].join(", ")}`)
    changed.clear()
    let resolved = yield* resolve(sources, builtins, host.importing)
    while (yield* watcher.update(resolved.watched)) resolved = yield* resolve(sources, builtins, host.importing)
    yield* publish(resolved.candidates.filter((c) => !isBuiltin(c)))
  }).pipe(logFailure("plugins: reload failed"))
  yield* Effect.sync(() => {
    if (reloading) return
    observed++
    if (release === undefined) release = host.holdNow()
    Queue.offerUnsafe(triggers, observed)
  }).pipe(Effect.delay(RECHECK), Effect.forever, Effect.forkScoped)
  yield* Stream.concat(Stream.succeed(0), Stream.fromQueue(triggers).pipe(Stream.debounce(DEBOUNCE))).pipe(
    Stream.runForEach((target) =>
      Effect.gen(function* () {
        reloading = true
        yield* reload
        if (observed !== target) return
        const settled = release
        release = undefined
        if (settled) yield* settled
      }).pipe(Effect.ensuring(Effect.sync(() => (reloading = false)))),
    ),
    Effect.forkScoped,
  )
})
