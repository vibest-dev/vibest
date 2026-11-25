import { importCheck, spawnDaemon } from "@vibest/client/client"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Concurrency } from "@vibest/core/concurrency"
import { Drain } from "@vibest/core/drain"
import { machinesListing, Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden, WrongInstance } from "@vibest/protocol/errors"
import { Caller } from "@vibest/protocol/middleware"
import { CAPABILITIES } from "@vibest/protocol/protocol"
import type { DaemonIdentity } from "@vibest/protocol/schemas"
import { Layout, shellQuote } from "@vibest/schema/layout"
import { LaunchFailed } from "@vibest/schema/session"
import { PROTOCOL } from "@vibest/schema/version"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Deferred, Effect, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ChildProcessSpawner } from "effect/process"

import { stopOnce as stopDaemon } from "../stop.ts"
import { UpdateCheck } from "../update-check.ts"
import * as CallerChecks from "./caller.ts"

export * as DaemonHandlers from "./daemon.ts"

export class Identity extends Context.Service<Identity, DaemonIdentity>()("vibest/DaemonIdentity") {}

export const identityNode = LayerNode.unbound(Identity)

export class Shutdown extends Context.Service<Shutdown, Deferred.Deferred<void>>()("vibest/DaemonShutdown") {}

export const shutdownNode = LayerNode.unbound(Shutdown)

export const DaemonHandler = HttpApiBuilder.group(VibestApi, "server.daemon", (handlers) =>
  Effect.gen(function* () {
    const { cliOnly } = yield* CallerChecks.Service
    const runtimes = yield* Runtimes.Service
    const concurrency = yield* Concurrency.Service
    const sessions = yield* Session.Service
    const identity = yield* Identity
    const updateStatus = yield* UpdateCheck.Service
    const { version } = yield* App.Service
    const shutdown = yield* Shutdown
    const drain = yield* Drain.Service
    const bus = yield* Bus.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const layout = yield* Layout
    const stopOnce = stopDaemon({ drain, bus, shutdown })

    return handlers
      .handle("daemon.ping", () =>
        machinesListing(runtimes, []).pipe(
          Effect.map((machines) =>
            machines.flatMap((machine) =>
              machine.runtimes.map((r) => ({
                kind: r.kind,
                status: r.status,
                ...(r.reason !== undefined && { reason: r.reason }),
              })),
            ),
          ),
          Effect.zip(updateStatus),
          Effect.map(([rows, update]) => ({
            protocol: PROTOCOL,
            version,
            runtimes: rows,
            update,
            ...identity,
            capabilities: CAPABILITIES,
          })),
        ),
      )
      .handle("daemon.concurrency", () =>
        Effect.map(concurrency.rules, (rules) => ({ ...rules, max: rules.max ?? null })),
      )
      .handle("daemon.republish", () => sessions.republish)
      .handle("daemon.stop", ({ payload: { instance } }) =>
        Effect.gen(function* () {
          const c = yield* Caller

          if (!Predicate.isTagged(c, "Cli"))
            return yield* new Forbidden({
              method: "daemon.stop",
              message: "only the user stops vibestd (vibest daemon restart); an agent may not",
            })

          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })

          return yield* stopOnce(instance, "daemon.stop", Effect.void)
        }),
      )
      .handle("daemon.handoff", ({ payload: { instance, command } }) =>
        Effect.gen(function* () {
          yield* cliOnly("daemon.handoff")

          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          const quoted = command.map(shellQuote).join(" ")

          const checked = yield* importCheck(command).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Layout, layout),
          )

          if (checked !== undefined)
            return yield* new LaunchFailed({
              message: `${quoted} cannot take over this vibestd (${checked}); it keeps running`,
            })

          return yield* stopOnce(
            instance,
            "daemon.handoff",
            spawnDaemon(command, ["--import"]).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Layout, layout),
              Effect.mapError(
                (e) => new LaunchFailed({ message: `${quoted} did not start: ${e.message}; vibestd keeps running` }),
              ),
            ),
          )
        }),
      )
  }),
)
