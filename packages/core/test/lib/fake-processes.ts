import { type Liveness, Processes } from "@vibest/core/processes"
import { Context, Deferred, type Duration, Effect, HashMap, Layer, Option, Ref } from "effect"

export class FakeProcesses extends Context.Service<
  FakeProcesses,
  {
    readonly set: (pid: number, liveness: Liveness) => Effect.Effect<void>
    readonly setCwdUsers: (users: ReadonlyArray<number> | undefined) => Effect.Effect<void>
    readonly setTree: (root: number, pids: ReadonlyArray<number>) => Effect.Effect<void>
    readonly probed: Effect.Effect<ReadonlyArray<number>>
    readonly signaled: Effect.Effect<ReadonlyArray<number>>
    readonly setSignalDenied: (denied: boolean) => Effect.Effect<void>
    readonly setSignalIgnored: (ignored: boolean) => Effect.Effect<void>
    readonly holdSignal: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    readonly holdCwd: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    readonly setCwdDelay: (delay: Duration.Input) => Effect.Effect<void>
    readonly cwdListings: Effect.Effect<number>
    readonly processes: Processes["Service"]
  }
>()("test/FakeProcesses") {
  static readonly layer = Layer.effect(
    FakeProcesses,
    Effect.gen(function* () {
      const states = yield* Ref.make(HashMap.empty<number, Liveness>())
      const users = yield* Ref.make<ReadonlyArray<number> | undefined>([])
      const trees = yield* Ref.make(HashMap.empty<number, ReadonlyArray<number>>())
      const cwdDelay = yield* Ref.make<Duration.Input>(0)
      const listings = yield* Ref.make(0)
      const probed = yield* Ref.make<ReadonlyArray<number>>([])
      const signaled = yield* Ref.make<ReadonlyArray<number>>([])
      const denied = yield* Ref.make(false)
      const ignored = yield* Ref.make(false)
      const signalGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const cwdGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const holdNext = (gate: typeof cwdGate) =>
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Ref.set(gate, Option.some({ reached, release }))
          return {
            reached: Deferred.await(reached),
            release: () => Deferred.succeed(release, undefined).pipe(Effect.asVoid),
          }
        })
      return FakeProcesses.of({
        set: (pid, liveness) => Ref.update(states, HashMap.set(pid, liveness)),
        setCwdUsers: (u) => Ref.set(users, u),
        setTree: (root, pids) => Ref.update(trees, HashMap.set(root, pids)),
        cwdListings: Ref.get(listings),
        probed: Ref.get(probed),
        signaled: Ref.get(signaled),
        setSignalDenied: (d) => Ref.set(denied, d),
        setSignalIgnored: (i) => Ref.set(ignored, i),
        holdSignal: () => holdNext(signalGate),
        holdCwd: () => holdNext(cwdGate),
        setCwdDelay: (d) => Ref.set(cwdDelay, d),
        processes: Processes.of({
          liveness: (pid) =>
            Ref.update(probed, (p) => [...p, pid]).pipe(
              Effect.andThen(Ref.get(states)),
              Effect.map((m) => Option.getOrElse(HashMap.get(m, pid), (): Liveness => "exited")),
            ),
          terminate: (pid) =>
            Effect.gen(function* () {
              const gate = yield* Ref.modify(
                signalGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
                for (let i = 0; i < 8; i++) yield* Effect.yieldNow
              }
              if (yield* Ref.get(denied)) return "denied" as const
              yield* Ref.update(signaled, (s) => [...s, pid])
              if (!(yield* Ref.get(ignored))) yield* Ref.update(states, HashMap.set(pid, "exited" as Liveness))
              return "sent" as const
            }),
          cwdUsers: () =>
            Effect.gen(function* () {
              yield* Ref.update(listings, (n) => n + 1)
              const gate = yield* Ref.modify(
                cwdGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
              }
              yield* Effect.sleep(yield* Ref.get(cwdDelay))
              return yield* Ref.get(users)
            }),
          tree: (root) => Ref.get(trees).pipe(Effect.map((m) => Option.getOrElse(HashMap.get(m, root), () => [root]))),
        }),
      })
    }),
  )
}
