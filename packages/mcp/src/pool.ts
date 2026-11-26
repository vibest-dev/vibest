import type { AuthProvider, FetchLike, Implementation } from "@modelcontextprotocol/client"
import { PlatformNode } from "@vibest/core/effect/platform"
import type { Mcp } from "@vibest/schema/mcp"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Layer,
  Path,
  Scope,
  Semaphore,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import { McpConnection } from "./connection.ts"
import { McpSecrets } from "./secrets.ts"

export * as McpPool from "./pool.ts"

export const DEFAULT_GLOBAL_IDLE_TIMEOUT_MS = 180_000
export const DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS = 60_000

export interface Selection {
  readonly key: string
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
}

export interface Input extends Omit<McpConnection.Input, "spawner" | "fs" | "path" | "fetch" | "endpointLocks"> {
  readonly select: Effect.Effect<Selection>
}

export interface PooledConnection extends McpConnection.Connection {
  readonly pinStream: () => Effect.Effect<void, never, Scope.Scope>
}

export interface Interface {
  readonly connection: (input: Input) => PooledConnection
  readonly activeSlotCount: Effect.Effect<number>
  readonly closeAll: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vibest/McpPool") {}

export const key = (input: {
  readonly config: Mcp.ServerConfig
  readonly cwd?: string | undefined
  readonly credentialId?: string | undefined
  readonly clientInfo?: Implementation | undefined
  readonly mcpEvents?: boolean | undefined
}): string => {
  const config = input.config
  const common = [config.protocol ?? "auto", config.timeout ?? null, input.clientInfo ?? null, input.mcpEvents === true]

  if (config.type === "remote") {
    return JSON.stringify([
      "remote",
      config.url,
      McpSecrets.fingerprintSecret(config.headers),
      McpSecrets.fingerprintSecret(config.bearerToken),
      config.oauth
        ? { ...config.oauth, clientSecret: McpSecrets.fingerprintSecret(config.oauth.clientSecret) }
        : (config.oauth ?? null),
      config.codemode !== false,
      input.credentialId ?? null,
      ...common,
    ])
  }

  return JSON.stringify([
    "local",
    config.command,
    input.cwd ?? null,
    McpSecrets.fingerprintSecret(config.environment),
    ...common,
  ])
}

export const poolKey = key

export const defaultIdleTimeoutMs = (config: Mcp.ServerConfig): number => {
  if (config.idleTimeoutMs !== undefined) return config.idleTimeoutMs

  if (config.type === "local" && config.cwd === undefined) return DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS

  return DEFAULT_GLOBAL_IDLE_TIMEOUT_MS
}

interface Holder {
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
  readonly closed: (reason: string) => void
  readonly changed: (kind: McpConnection.Kind) => void
}

type Outcome = "connected" | "private" | McpConnection.Failure

interface Slot {
  readonly connection: McpConnection.Connection
  readonly holders: Set<Holder>
  readonly lock: Semaphore.Semaphore
  readonly outcome: Deferred.Deferred<Outcome>
  readonly idleTimeoutMs: number
  start: Fiber.Fiber<void> | undefined
  idleFiber: Fiber.Fiber<void> | undefined
  activeStreams: number
  connected: boolean
}

interface PooledConnectionState {
  claim: Scope.Closeable | undefined
  holder: Holder | undefined
  shared: McpConnection.Connection | undefined
  sharedSlot: { readonly key: string; readonly slot: Slot } | undefined
  own: McpConnection.Connection | undefined
  selected: Selection | undefined
}

export const make = Effect.fn("McpPool.make")(function* (options?: { readonly baseFetch?: FetchLike }) {
  const scope = yield* Effect.scope
  const run = yield* FiberSet.makeRuntime<never, void, never>()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fetch = yield* FetchHttpClient.Fetch
  const endpointLocks = KeyedMutex.makeUnsafe<string>()
  const slots = new Map<string, Slot>()
  const unpoolable = new Set<string>()
  const legacy = new Set<string>()

  const detach = (key: string, slot: Slot) => {
    if (slots.get(key) === slot) slots.delete(key)
  }

  const cancelIdleReaper = (slot: Slot): Effect.Effect<void> =>
    Effect.suspend(() => {
      const fiber = slot.idleFiber

      if (!fiber) return Effect.void
      slot.idleFiber = undefined

      return Fiber.interrupt(fiber)
    })

  const closeSlot = (key: string, slot: Slot): Effect.Effect<void> =>
    Effect.gen(function* () {
      detach(key, slot)
      yield* cancelIdleReaper(slot)

      if (slot.start) yield* Fiber.interrupt(slot.start)
      yield* slot.connection.stop.pipe(slot.lock.withPermit)
    })

  const scheduleIdleReaper = (key: string, slot: Slot): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (slot.holders.size > 0 || slot.activeStreams > 0) return Effect.void

      if (slot.idleTimeoutMs <= 0) return closeSlot(key, slot)

      return Effect.gen(function* () {
        yield* cancelIdleReaper(slot)

        const fiber = run(
          Effect.sleep(Duration.millis(slot.idleTimeoutMs)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (slot.holders.size > 0 || slot.activeStreams > 0) return Effect.void

                if (slots.get(key) !== slot) return Effect.void
                slot.idleFiber = undefined

                return closeSlot(key, slot)
              }),
            ),
          ),
        )

        slot.idleFiber = fiber
      })
    })

  const open = (
    key: string,
    input: Pick<
      Input,
      | "name"
      | "config"
      | "directory"
      | "vibestHome"
      | "npmCacheDir"
      | "clientInfo"
      | "mcpEvents"
      | "eventStreamIdleTimeout"
      | "baseFetch"
    >,
  ): Slot => {
    const slot: Slot = {
      holders: new Set(),
      lock: Semaphore.makeUnsafe(1),
      outcome: Deferred.makeUnsafe(),
      idleTimeoutMs: defaultIdleTimeoutMs(input.config),
      start: undefined,
      idleFiber: undefined,
      activeStreams: 0,
      connected: false,
      connection: McpConnection.make({
        name: input.name,
        config: input.config,
        directory: input.directory,
        vibestHome: input.vibestHome,
        npmCacheDir: input.npmCacheDir,
        shared: true,
        clientInfo: input.clientInfo,
        mcpEvents: input.mcpEvents,
        eventStreamIdleTimeout: input.eventStreamIdleTimeout,
        authProvider: Effect.suspend(() => slot.holders.values().next().value?.authProvider ?? Effect.undefined),
        baseFetch: input.baseFetch ?? options?.baseFetch,
        fetch,
        fs,
        path,
        spawner,
        scope,
        lock: (effect) => slot.lock.withPermit(effect),
        callbacks: (effect) => {
          run(effect)
        },
        fork: (effect) => {
          run(effect)
        },
        endpointLocks,
        events: {
          connecting: Effect.void,
          connected: Effect.void,
          failed: (failure, answered) =>
            Effect.gen(function* () {
              detach(key, slot)

              if (answered) unpoolable.add(key)
              yield* Deferred.succeed(slot.outcome, answered ? "private" : failure)
            }),
          legacy: () =>
            Effect.gen(function* () {
              detach(key, slot)
              unpoolable.add(key)
              legacy.add(key)
              yield* Deferred.succeed(slot.outcome, "private")
            }),
          settled: Effect.void,
          closed: (reason) =>
            Effect.gen(function* () {
              detach(key, slot)
              yield* cancelIdleReaper(slot)
              const holders = Array.from(slot.holders)
              slot.holders.clear()
              yield* slot.connection.stop

              for (const holder of holders) holder.closed(reason)
            }),
          changed: (kind) =>
            Effect.sync(() => {
              if (slot.connected) {
                for (const holder of slot.holders) holder.changed(kind)
              }
            }),
        },
      }),
    }

    slots.set(key, slot)

    return slot
  }

  const connectSlot = (key: string, slot: Slot) =>
    Effect.gen(function* () {
      yield* slot.connection.start

      if (!slot.connection.client) return
      slot.connected = true
      yield* Deferred.succeed(slot.outcome, "connected")
    }).pipe(
      slot.lock.withPermit,
      Effect.onError((cause) =>
        Effect.suspend(() => {
          detach(key, slot)

          return Deferred.succeed(slot.outcome, { status: "failed", error: String(Cause.squash(cause)) })
        }),
      ),
    )

  const release = (key: string, slot: Slot, holder: Holder): Effect.Effect<void> =>
    Effect.suspend(() => {
      slot.holders.delete(holder)

      if (slot.holders.size > 0) return Effect.void

      if (!slot.connected) return closeSlot(key, slot)

      return scheduleIdleReaper(key, slot)
    })

  const acquire = Effect.fn("McpPool.acquire")(function* (key: string, input: Input, holder: Holder) {
    if (unpoolable.has(key)) return { kind: "private" as const }

    const slot =
      slots.get(key) ??
      open(key, {
        name: input.name,
        config: input.config,
        directory: input.directory,
        vibestHome: input.vibestHome,
        npmCacheDir: input.npmCacheDir,
        clientInfo: input.clientInfo,
        mcpEvents: input.mcpEvents,
        eventStreamIdleTimeout: input.eventStreamIdleTimeout,
        baseFetch: input.baseFetch,
      })

    yield* cancelIdleReaper(slot)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        slot.holders.add(holder)
      }),
      () => release(key, slot, holder),
    )

    slot.start ??= run(connectSlot(key, slot))
    const outcome = yield* Deferred.await(slot.outcome)

    if (outcome === "connected") return { kind: "connected" as const, slot, key }

    if (outcome === "private") return { kind: "private" as const }

    return { kind: "failed" as const, failure: outcome }
  })

  const connection = (input: Input): PooledConnection => {
    const state: PooledConnectionState = {
      claim: undefined,
      holder: undefined,
      shared: undefined,
      sharedSlot: undefined,
      own: undefined,
      selected: undefined,
    }

    const privately = (config: Mcp.ServerConfig) =>
      McpConnection.make({
        ...input,
        config,
        spawner,
        fs,
        path,
        fetch,
        endpointLocks,
        baseFetch: input.baseFetch ?? options?.baseFetch,
        authProvider: Effect.suspend(() => state.selected?.authProvider ?? input.authProvider),
      })

    const configured = privately(input.config)
    const older = privately({ ...input.config, protocol: "legacy" })
    const live = () => state.shared ?? state.own ?? configured

    const current = (holder: Holder, effect: () => Effect.Effect<void>) =>
      input.callbacks(
        Effect.suspend(() => (state.holder === holder ? effect() : Effect.void)).pipe(input.lock, Effect.ignore),
      )

    const clear = Effect.suspend(() => {
      const claim = state.claim
      state.claim = undefined
      state.holder = undefined
      state.shared = undefined
      state.sharedSlot = undefined

      return claim ? Scope.close(claim, Exit.void) : Effect.void
    })

    const join = (selected: Selection) =>
      Effect.gen(function* () {
        yield* input.events.connecting
        const claim = yield* Scope.fork(input.scope)

        const holder: Holder = {
          authProvider: selected.authProvider,
          closed: (reason) => current(holder, () => input.events.closed(reason)),
          changed: (kind) => current(holder, () => input.events.changed(kind)),
        }

        state.claim = claim
        state.holder = holder

        const outcome = yield* acquire(selected.key, input, holder).pipe(
          Scope.provide(claim),
          Effect.onInterrupt(() => clear),
        )

        if (outcome.kind === "private") {
          yield* clear

          return false
        }

        if (outcome.kind === "failed") {
          yield* clear
          yield* input.events.failed(outcome.failure, false)

          return true
        }

        state.shared = outcome.slot.connection
        state.sharedSlot = { key: outcome.key, slot: outcome.slot }
        yield* input.events.connected

        return true
      }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) && !exit.value ? Effect.void : input.events.settled)))

    return {
      get client() {
        return live().client
      },
      get tools() {
        return live().tools
      },
      get toolsMeta() {
        return live().toolsMeta
      },
      get prompts() {
        return live().prompts
      },
      start: Effect.gen(function* () {
        const selected = yield* input.select
        state.selected = selected

        if (input.config.pool !== false && !unpoolable.has(selected.key) && (yield* join(selected))) return
        state.own = legacy.has(selected.key) ? older : configured
        yield* state.own.start
      }),
      stop: Effect.gen(function* () {
        if (!state.claim) return yield* (state.own ?? configured).stop
        yield* clear
        yield* input.events.changed("tools")
        yield* input.events.changed("resources")
        yield* input.events.changed("prompts")
      }),
      refreshTools: () => live().refreshTools(),
      recovering: (client, request) =>
        state.shared ? state.shared.recovering(client, request) : (state.own ?? configured).recovering(client, request),
      catalog: (client) => live().catalog(client),
      pinStream: () =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            const target = state.sharedSlot

            if (!target) return Effect.succeed(undefined)
            target.slot.activeStreams += 1

            return cancelIdleReaper(target.slot).pipe(Effect.as(target))
          }),
          (target) =>
            Effect.suspend(() => {
              if (!target) return Effect.void
              target.slot.activeStreams = Math.max(0, target.slot.activeStreams - 1)

              if (target.slot.holders.size === 0 && target.slot.activeStreams === 0) {
                return scheduleIdleReaper(target.key, target.slot)
              }

              return Effect.void
            }),
        ).pipe(Effect.asVoid),
    }
  }

  const closeAll = Effect.gen(function* () {
    const all = Array.from(slots.entries())
    yield* Effect.forEach(all, ([key, slot]) => closeSlot(key, slot), { concurrency: "unbounded", discard: true })
  })

  yield* Scope.addFinalizer(scope, closeAll.pipe(Effect.ignore))

  return Service.of({
    connection,
    activeSlotCount: Effect.sync(() => slots.size),
    closeAll,
  })
})

export const layer = (options?: { readonly baseFetch?: FetchLike }) => Layer.effect(Service, make(options))

export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [PlatformNode.childProcessSpawner, PlatformNode.fileSystem, PlatformNode.path, PlatformNode.fetch],
})
