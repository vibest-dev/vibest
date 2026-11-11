import { Duration, Effect, type Latch, Queue, Stream } from "effect"

import { logFailure } from "./engine.ts"
import { type Candidate, makeSources, makeWatcher, type Operation } from "./plugin-sources.ts"

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
  const changed = new Set<string>()
  let observed = 0
  host.ready.closeUnsafe()
  const notify = (file?: string) => {
    if (file !== undefined) changed.add(file)
    observed++
    host.ready.closeUnsafe()
    Queue.offerUnsafe(triggers, undefined)
  }
  let active: ReadonlyArray<Candidate> = []
  const watcher = yield* makeWatcher(notify)
  const scope = yield* Effect.scope
  const activate = (candidates: ReadonlyArray<Candidate>) =>
    host.activate(candidates).pipe(Effect.tap(() => Effect.sync(() => (active = candidates))))
  const applyBuiltinRemovals = Effect.gen(function* () {
    const { operations } = yield* sources.operations
    yield* activate([...keptBuiltins(builtins, operations), ...active.filter((c) => !isBuiltin(c))])
  })
  yield* applyBuiltinRemovals
  const reload = Effect.gen(function* () {
    const generation = observed
    if (changed.size > 0) yield* Effect.log(`plugins: reloading after changes to ${[...changed].join(", ")}`)
    changed.clear()
    yield* applyBuiltinRemovals
    let resolved = yield* resolve(sources, builtins)
    let rewatched = false
    while (yield* watcher.update(resolved.watched)) {
      rewatched = true
      yield* applyBuiltinRemovals
      resolved = yield* resolve(sources, builtins)
    }
    if (observed !== generation) return
    yield* activate(resolved.candidates)
    if (rewatched) yield* Effect.sleep(RECHECK).pipe(Effect.andThen(Effect.sync(() => notify())), Effect.forkIn(scope))
  }).pipe(logFailure("plugins: reload failed"))
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
