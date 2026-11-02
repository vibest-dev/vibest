// The Pi extension API as an Effect service. Only this file touches `api`. `runMain` is the entry, like
// NodeRuntime.runMain: Pi calls the extension factory once per session and awaits it, then awaits `session_shutdown`.
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

/** The events vibest handles: what Pi passes, and what the handler may return to it. */
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
    /** Handle `event` while the scope is open; Pi awaits the Effect and uses its value, and reports its failure. */
    readonly handle: <K extends keyof Events, E, R>(
      event: K,
      f: (event: Events[K]["event"], ctx: ExtensionContext) => Effect.Effect<Events[K]["result"], E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>
    readonly sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => Effect.Effect<void>
    /** Run another extension's factory on this session's `api`, while the extension loads. */
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
            // `on` is overloaded per event name; `Events` pins each name to its overload's types.
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

  /**
   * Build `extension` in a scope that lives as long as this session; the factory's promise resolves once it is built
   * (its handlers are registered before Pi goes on to `session_start`), and rejects when that fails, so Pi reports
   * the extension as failed to load. `session_shutdown` closes the scope and waits for the finalizers; that handler
   * stays outside the scope, which would remove it along with everything else.
   */
  static readonly runMain = <E>(api: ExtensionAPI, extension: Layer.Layer<never, E, Pi>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        api.on("session_shutdown", () => Effect.runPromise(Scope.close(scope, Exit.void)))
        yield* Layer.buildWithScope(extension, scope).pipe(Effect.provide(Pi.layer(api)))
      }),
    )
}
