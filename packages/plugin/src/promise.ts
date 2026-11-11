import type { FactOf, FactType } from "@vibest/schema/event"
import { Effect, type Scope, Stream } from "effect"

import type { HarnessEditor } from "./harness.ts"
import type {
  AgentHooks,
  AgentResults,
  Context,
  MachineHookOptions,
  MachineHooks,
  MachineNote,
  PluginOptions,
  SubscriptionReport,
} from "./index.ts"
import type { Cleanup, PromisePlugin } from "./plugin.ts"
import type { Registration } from "./registration.ts"
import type { RuntimeEditor } from "./runtime.ts"

type Awaitable<A> = Promise<A> | A

export interface PromiseRegistration {
  readonly dispose: () => Promise<void>
}

export interface PromiseDefinitions<Editor> {
  readonly transform: (callback: (editor: Editor) => void) => Promise<PromiseRegistration>
  readonly reload: () => Promise<void>
}

export interface PromiseContext {
  readonly options: PluginOptions
  readonly agent: {
    readonly hook: <Name extends keyof AgentHooks>(
      name: Name,
      callback: (event: AgentHooks[Name]) => Awaitable<AgentResults[Name] | void>,
    ) => Promise<PromiseRegistration>
  }
  readonly machine: {
    readonly hook: <Name extends keyof MachineHooks>(
      name: Name,
      callback: (event: MachineHooks[Name]) => Awaitable<ReadonlyArray<MachineNote> | void>,
      options?: MachineHookOptions,
    ) => Promise<PromiseRegistration>
  }
  readonly runtime: PromiseDefinitions<RuntimeEditor>
  readonly harness: PromiseDefinitions<HarnessEditor>
  readonly subscription: { readonly report: (input: SubscriptionReport) => Promise<void> }
  readonly event: {
    readonly subscribe: <T extends FactType = FactType>(input?: {
      readonly types?: ReadonlyArray<T>
    }) => AsyncIterable<FactOf<T>>
  }
}

const isRefusal = (e: unknown) => (e as { readonly _tag?: unknown } | undefined)?._tag === "AgentRefused"

const settle = <A>(callback: () => Awaitable<A>) => Effect.promise(() => Promise.resolve().then(callback))

const refusable = <A>(callback: () => Awaitable<A>) =>
  Effect.tryPromise({ try: () => Promise.resolve().then(callback), catch: (e) => e }).pipe(
    Effect.catch((e) => (isRefusal(e) ? Effect.fail(e as never) : Effect.die(e))),
  )

export const fromPromise =
  (plugin: PromisePlugin) =>
  (host: Context): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.context<Scope.Scope>()
      const run = Effect.runPromiseWith(scope)
      const register = (registering: Effect.Effect<Registration, never, Scope.Scope>) =>
        run(registering).then((registration): PromiseRegistration => ({ dispose: () => run(registration.dispose) }))
      const iterators = new Set<AsyncIterator<unknown>>()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all(Array.from(iterators, (iterator) => iterator.return?.()))),
      )
      const iterable = <A>(stream: Stream.Stream<A>): AsyncIterable<A> => ({
        [Symbol.asyncIterator]: () => {
          const iterator = Stream.toAsyncIterableWith(stream, scope)[Symbol.asyncIterator]()
          iterators.add(iterator)
          return iterator
        },
      })
      const definitions = <Editor>(domain: Context["runtime"] | Context["harness"]): PromiseDefinitions<Editor> => ({
        transform: (callback) => register(domain.transform(callback as never)),
        reload: () => run(domain.reload()),
      })
      const context: PromiseContext = {
        options: host.options,
        agent: {
          hook: (name, callback) => register(host.agent.hook(name, (event) => refusable(() => callback(event)))),
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
