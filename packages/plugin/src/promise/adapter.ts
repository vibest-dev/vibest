import { Effect, Predicate, type Scope, Stream } from "effect"

import type { SessionFailures, SessionHooks, SessionRefused, ToolRefused } from "../domain.ts"
import type { Context as EffectContext } from "../effect/index.ts"
import type { Registration as EffectRegistration, Transform } from "../effect/registration.ts"
import type { Cleanup, Context, Plugin } from "./plugin.ts"
import type { Definitions, Registration } from "./registration.ts"

type Awaitable<A> = Promise<A> | A

const isSessionRefused = (cause: unknown): cause is SessionRefused => Predicate.isTagged(cause, "SessionRefused")
const isToolRefused = (cause: unknown): cause is ToolRefused => Predicate.isTagged(cause, "ToolRefused")

const settle = <A>(callback: () => Awaitable<A>) => Effect.promise(() => Promise.resolve().then(callback))

type FailureHandlers = {
  readonly [N in keyof SessionHooks]: (cause: unknown) => Effect.Effect<never, SessionFailures[N]>
}

const handleFailure: FailureHandlers = {
  "start.before": (cause) => (isSessionRefused(cause) ? Effect.fail(cause) : Effect.die(cause)),
  "tool.execute.before": (cause) => (isToolRefused(cause) ? Effect.fail(cause) : Effect.die(cause)),
}

const refusable = <N extends keyof SessionHooks, A>(name: N, callback: () => Awaitable<A>) =>
  Effect.tryPromise({ try: () => Promise.resolve().then(callback), catch: (e) => e }).pipe(
    Effect.catch(handleFailure[name]),
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
                (cause: unknown) => close().then(() => Promise.reject(cause)),
              ),
            return: close,
          }

          iterators.add(iterator)

          return iterator
        },
      })

      const definitions = <Editor>(domain: { readonly transform: Transform<Editor> }): Definitions<Editor> => ({
        transform: (callback) => register(domain.transform(callback)),
      })

      const context: Context = {
        options: host.options,
        agent: {
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
        session: {
          hook: (name, callback) =>
            register(host.session.hook(name, (event) => refusable(name, () => callback(event)))),
          list: () => run(host.session.list()),
          get: (id) => run(host.session.get(id)),
          sentIn: (id, execution) => run(host.session.sentIn(id, execution)),
          send: (input) => run(host.session.send(input)),
          stop: (id, options) => run(host.session.stop(id, options)),
        },
      }

      yield* Effect.acquireRelease(
        settle(() => plugin.setup(context)),
        (cleanup: Cleanup | void) => (cleanup === undefined ? Effect.void : settle(cleanup)),
        { interruptible: true },
      )
    })
