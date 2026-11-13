import { Cause, Duration, Effect, type Latch, Queue, Semaphore, Stream } from "effect"

import { type Candidate, keyOf, makeSources, makeWatcher, type Operation } from "./plugin-sources.ts"
import { logFailure } from "./reactor.ts"

export const DEBOUNCE = Duration.millis(100)
export const RECHECK = Duration.seconds(1)

type Sources = Effect.Success<ReturnType<typeof makeSources>>

interface Host {
  readonly activate: (candidates: ReadonlyArray<Candidate>) => Effect.Effect<void>
  readonly ready: Latch.Latch
}

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

export const resolve = Effect.fnUntraced(function* (sources: Sources, builtins: ReadonlyArray<Candidate> = []) {
  const { operations, watched } = yield* sources.operations
  const candidates: Array<Candidate> = [...builtins]
  for (const op of operations) {
    if (op.type === "remove") {
      removeMatching(candidates, op.target)
      continue
    }
    const candidate = yield* sources.load(op, watched)
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
  const triggers = yield* Queue.sliding<void>(1)
  const builtinTriggers = yield* Queue.sliding<void>(1)
  const changed = new Set<string>()
  let observed = 0
  host.ready.closeUnsafe()
  const notify = (file?: string) => {
    if (file !== undefined) changed.add(file)
    observed++
    host.ready.closeUnsafe()
    Queue.offerUnsafe(triggers, undefined)
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
        host.ready.closeUnsafe()
        yield* host.activate(candidates)
        activated = revisions
      }),
    )
  yield* publish().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("failed to activate plugins", { cause, readable: Cause.pretty(cause) }),
    ),
  )
  yield* Stream.fromQueue(builtinTriggers).pipe(
    Stream.runForEach(() => publish().pipe(logFailure("plugins: builtin update failed"))),
    Effect.forkScoped,
  )
  const reload = Effect.gen(function* () {
    if (changed.size > 0) yield* Effect.log(`plugins: reloading after changes to ${[...changed].join(", ")}`)
    changed.clear()
    let resolved = yield* resolve(sources, builtins)
    while (yield* watcher.update(resolved.watched)) resolved = yield* resolve(sources, builtins)
    yield* publish(resolved.candidates.filter((c) => !isBuiltin(c)))
  }).pipe(logFailure("plugins: reload failed"))
  yield* Queue.offer(triggers, undefined).pipe(Effect.delay(RECHECK), Effect.forever, Effect.forkScoped)
  yield* Stream.concat(Stream.succeed(undefined), Stream.fromQueue(triggers).pipe(Stream.debounce(DEBOUNCE))).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const target = observed
        yield* reload
        if (observed === target) host.ready.openUnsafe()
      }),
    ),
    Effect.forkScoped,
  )
})
