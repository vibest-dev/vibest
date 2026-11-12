import { Duration, Effect, FiberHandle, type Latch, Queue, Stream } from "effect"

import { logFailure } from "./engine.ts"
import { type Candidate, makeSources, makeWatcher } from "./plugin-sources.ts"

export const DEBOUNCE = Duration.millis(100)
export const RECHECK = Duration.seconds(1)

type Sources = Effect.Success<ReturnType<typeof makeSources>>

interface Host {
  readonly activate: (candidates: ReadonlyArray<Candidate>) => Effect.Effect<void>
  readonly ready: Latch.Latch
}

const matches = (selector: string, id: string) =>
  selector === "*" || (selector.endsWith(".*") ? id.startsWith(selector.slice(0, -1)) : selector === id)

export const resolve = Effect.fnUntraced(function* (sources: Sources) {
  const { operations, watched } = yield* sources.operations
  const candidates: Array<Candidate> = []
  for (const op of operations) {
    if (op.type === "remove") {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const p = candidates[i]!.plugin
        if ("error" in p ? op.target === "*" : matches(op.target, p.id)) candidates.splice(i, 1)
      }
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
  const watcher = yield* makeWatcher(notify, RECHECK)
  const rescanWhenLive = yield* FiberHandle.make()
  const reload = Effect.gen(function* () {
    if (changed.size > 0) yield* Effect.log(`plugins: reloading after changes to ${[...changed].join(", ")}`)
    changed.clear()
    let resolved = yield* resolve(sources)
    let rewatched = false
    while (yield* watcher.update(resolved.watched)) {
      rewatched = true
      resolved = yield* resolve(sources)
    }
    yield* host.activate([...builtins, ...resolved.candidates])
    if (rewatched)
      yield* FiberHandle.run(rescanWhenLive, watcher.live.pipe(Effect.andThen(Effect.sync(() => notify()))))
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
