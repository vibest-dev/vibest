import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { Context, Effect, Exit, FiberSet, Layer, Scope } from "effect"

interface Events {
  readonly session_start: { readonly event: SessionStartEvent; readonly result: void }
  readonly resources_discover: {
    readonly event: ResourcesDiscoverEvent
    readonly result: ResourcesDiscoverResult | void
  }
  readonly before_agent_start: { readonly event: BeforeAgentStartEvent; readonly result: void }
  readonly input: { readonly event: InputEvent; readonly result: InputEventResult | void }
  readonly tool_call: { readonly event: ToolCallEvent; readonly result: ToolCallEventResult | undefined }
  readonly agent_end: { readonly event: AgentEndEvent; readonly result: void }
  readonly agent_settled: { readonly event: AgentSettledEvent; readonly result: void }
}

export class Pi extends Context.Service<
  Pi,
  {
    readonly handle: <K extends keyof Events, E, R>(
      event: K,
      f: (event: Events[K]["event"], ctx: ExtensionContext) => Effect.Effect<Events[K]["result"], E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>
    readonly sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => Effect.Effect<void>
    readonly load: (factory: (api: ExtensionAPI) => void) => Effect.Effect<void>
  }
>()("@vibest/pi/Pi") {
  static readonly layer = (api: ExtensionAPI) =>
    Layer.succeed(
      Pi,
      Pi.of({
        handle: <K extends keyof Events, E, R>(
          event: K,
          f: (event: Events[K]["event"], ctx: ExtensionContext) => Effect.Effect<Events[K]["result"], E, R>,
        ) =>
          Effect.gen(function* () {
            const run = yield* FiberSet.makeRuntimePromise<R>()
            const on = api.on as (
              event: K,
              handler: (e: Events[K]["event"], ctx: ExtensionContext) => Promise<Events[K]["result"]>,
            ) => () => void
            yield* Effect.acquireRelease(
              Effect.sync(() => on(event, (e, ctx) => run(f(e, ctx)))),
              (off) => Effect.sync(off),
            )
          }),
        sendMessage: (...args) => Effect.sync(() => api.sendMessage(...args)),
        load: (factory) => Effect.sync(() => factory(api)),
      }),
    )

  static readonly runMain = <E>(api: ExtensionAPI, extension: Layer.Layer<never, E, Pi>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        api.on("session_shutdown", () => Effect.runPromise(Scope.close(scope, Exit.void)))
        yield* Layer.buildWithScope(extension, scope).pipe(Effect.provide(Pi.layer(api)))
      }),
    )
}
