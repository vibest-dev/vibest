import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageStartEvent,
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
  readonly message_start: { readonly event: MessageStartEvent; readonly result: void }
  readonly agent_end: { readonly event: AgentEndEvent; readonly result: void }
  readonly agent_settled: { readonly event: AgentSettledEvent; readonly result: void }
}

type Registrars = {
  readonly [K in keyof Events]: (
    handler: (e: Events[K]["event"], ctx: ExtensionContext) => Promise<Events[K]["result"]>,
  ) => () => void
}

const registrars = (api: Pick<ExtensionAPI, "on">): Registrars => ({
  session_start: (handler) => api.on("session_start", handler),
  resources_discover: (handler) => api.on("resources_discover", handler),
  before_agent_start: (handler) => api.on("before_agent_start", handler),
  input: (handler) => api.on("input", handler),
  tool_call: (handler) => api.on("tool_call", handler),
  message_start: (handler) => api.on("message_start", handler),
  agent_end: (handler) => api.on("agent_end", handler),
  agent_settled: (handler) => api.on("agent_settled", handler),
})

export class Pi extends Context.Service<
  Pi,
  {
    readonly handle: <K extends keyof Events, E, R>(
      event: K,
      f: (event: Events[K]["event"], ctx: ExtensionContext) => Effect.Effect<Events[K]["result"], E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>
    readonly sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => Effect.Effect<void>
  }
>()("@vibest/pi/Pi") {
  static readonly layer = (api: Pick<ExtensionAPI, "on" | "sendMessage">) =>
    Layer.succeed(
      Pi,
      Pi.of({
        handle: <K extends keyof Events, E, R>(
          event: K,
          f: (event: Events[K]["event"], ctx: ExtensionContext) => Effect.Effect<Events[K]["result"], E, R>,
        ) =>
          Effect.gen(function* () {
            const run = yield* FiberSet.makeRuntimePromise<R>()

            const on = registrars(api)[event]

            yield* Effect.acquireRelease(
              Effect.sync(() => on((e, ctx) => run(f(e, ctx)))),
              (off) => Effect.sync(off),
            )
          }),
        sendMessage: (...args) => Effect.sync(() => api.sendMessage(...args)),
      }),
    )

  static readonly runMain = <E>(api: Pick<ExtensionAPI, "on" | "sendMessage">, extension: Layer.Layer<never, E, Pi>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        api.on("session_shutdown", () => Effect.runPromise(Scope.close(scope, Exit.void)))
        yield* Layer.buildWithScope(extension, scope).pipe(Effect.provide(Pi.layer(api)))
      }),
    )
}
