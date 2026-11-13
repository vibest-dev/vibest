import { Effect, type Scope, Stream } from "effect"

import type { Context as EffectContext } from "../effect/index.ts"
import type { Registration as EffectRegistration } from "../effect/registration.ts"
import type { Cleanup, Context, Plugin } from "./plugin.ts"
import type { Definitions, Registration } from "./registration.ts"

type Awaitable<A> = Promise<A> | A

const isRefusal = (e: unknown) => (e as { readonly _tag?: unknown } | undefined)?._tag === "AgentRefused"

const settle = <A>(callback: () => Awaitable<A>) => Effect.promise(() => Promise.resolve().then(callback))

const refusable = <A>(callback: () => Awaitable<A>) =>
  Effect.tryPromise({ try: () => Promise.resolve().then(callback), catch: (e) => e }).pipe(
    Effect.catch((e) => (isRefusal(e) ? Effect.fail(e as never) : Effect.die(e))),
  )

export const fromPromise =
  (plugin: Plugin) =>
  (host: EffectContext): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.context<Scope.Scope>()
      const run = Effect.runPromiseWith(scope)
      const register = (registering: Effect.Effect<EffectRegistration, never, Scope.Scope>) =>
        run(registering).then((registration): Registration => ({ dispose: () => run(registration.dispose) }))
      const iterators = new Set<AsyncIterator<unknown>>()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all(Array.from(iterators, (iterator) => iterator.return?.()))),
      )
      const iterable = <A>(stream: Stream.Stream<A>): AsyncIterable<A> => ({
        [Symbol.asyncIterator]: () => {
          const source = Stream.toAsyncIterableWith(stream, scope)[Symbol.asyncIterator]()
          const close = () => {
            iterators.delete(iterator)
            return source.return?.() ?? Promise.resolve({ done: true as const, value: undefined })
          }
          const iterator: AsyncIterator<A> = {
            next: () =>
              source.next().then(
                (result) => (result.done === true ? close().then(() => result) : result),
                (error: unknown) => close().then(() => Promise.reject(error)),
              ),
            return: close,
          }
          iterators.add(iterator)
          return iterator
        },
      })
      const definitions = <Editor>(
        domain: EffectContext["runtime"] | EffectContext["harness"],
      ): Definitions<Editor> => ({
        transform: (callback) => register(domain.transform(callback as never)),
        reload: () => run(domain.reload()),
      })
      const context: Context = {
        options: host.options,
        agent: {
          hook: (name, callback) => register(host.agent.hook(name, (event) => refusable(() => callback(event)))),
          transform: (callback) => register(host.agent.transform(callback)),
        },
        machine: {
          hook: (name, callback, options) =>
            register(host.machine.hook(name, (event) => settle(() => callback(event)), options)),
        },
        runtime: definitions(host.runtime),
        harness: definitions(host.harness),
        subscription: { report: (input) => run(host.subscription.report(input)) },
        event: { subscribe: (input) => iterable(host.event.subscribe(input)) },
      }
      yield* Effect.acquireRelease(
        settle(() => plugin.setup(context)),
        (cleanup: Cleanup | void) => (cleanup === undefined ? Effect.void : settle(cleanup)),
        { interruptible: true },
      )
    })
