import { importCheck, spawnDaemon } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { shellQuote } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { machinesListing, Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { UpdateCheck } from "@vibest/core/update-check"
import { Caller, CAPABILITIES, type DaemonIdentity, Forbidden, WrongInstance } from "@vibest/protocol/rpc"
import { LaunchFailed } from "@vibest/schema/session"
import { PROTOCOL, VERSION } from "@vibest/schema/version"
import { Context, Deferred, Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { stopOnce as stopDaemon } from "../stop.ts"
import type { Checks, Handlers } from "./caller.ts"

export class Identity extends Context.Service<Identity, DaemonIdentity>()("vibest/DaemonIdentity") {
  static readonly node = LayerNode.unbound(Identity)
}

export class Shutdown extends Context.Service<Shutdown, Deferred.Deferred<void>>()("vibest/DaemonShutdown") {
  static readonly node = LayerNode.unbound(Shutdown)
}

export const make = ({ cliOnly }: Checks) =>
  Effect.gen(function* () {
    const db = yield* Db
    const runtimes = yield* Runtimes
    const plugins = yield* Plugins
    const subscriptions = yield* Subscriptions
    const identity = yield* Identity
    const updateStatus = yield* UpdateCheck
    const shutdown = yield* Shutdown
    const drain = yield* Drain
    const bus = yield* Bus
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stopOnce = stopDaemon({ drain, bus, deliveringInbox: db.deliveringInbox, shutdown })
    return {
      Ping: () =>
        machinesListing(runtimes, []).pipe(
          Effect.map((machines) =>
            machines.flatMap((machine) =>
              machine.runtimes.map((r) => ({
                kind: r.kind,
                status: r.status,
                ...(r.reason !== undefined ? { reason: r.reason } : {}),
              })),
            ),
          ),
          Effect.zip(updateStatus),
          Effect.map(([rows, update]) => ({
            protocol: PROTOCOL,
            version: VERSION,
            runtimes: rows,
            update,
            ...identity,
            capabilities: CAPABILITIES,
          })),
        ),

      Plugins: () => plugins.list,

      "Runtimes.Doctor": ({ harnesses }) =>
        Effect.flatMap(runtimes.statuses, (rows) =>
          Effect.forEach(rows, ({ runtime, status }) =>
            (runtime.doctor ? runtime.doctor(harnesses) : Effect.succeed({ name: runtime.id, checks: [] })).pipe(
              Effect.map((report) => ({
                kind: runtime.id,
                status: status.status,
                ...("reason" in status ? { reason: status.reason } : {}),
                name: report.name,
                checks: report.checks,
              })),
            ),
          ),
        ),

      Subscriptions: () => subscriptions.list,

      "Daemon.Stop": ({ instance }) =>
        Effect.gen(function* () {
          const c = yield* Caller
          if (c._tag !== "Cli")
            return yield* new Forbidden({
              method: "Daemon.Stop",
              message: "only the user stops vibestd (vibest daemon restart); an agent may not",
            })
          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          return yield* stopOnce(instance, "Daemon.Stop", Effect.void)
        }),

      "Daemon.Handoff": ({ instance, command }) =>
        Effect.gen(function* () {
          yield* cliOnly("Daemon.Handoff")
          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          const quoted = command.map(shellQuote).join(" ")
          const checked = yield* importCheck(command).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
          if (checked !== undefined)
            return yield* new LaunchFailed({
              message: `${quoted} cannot take over this vibestd (${checked}); it keeps running`,
            })
          return yield* stopOnce(
            instance,
            "Daemon.Handoff",
            spawnDaemon(command, ["--import"]).pipe(
              Effect.mapError(
                (e) => new LaunchFailed({ message: `${quoted} did not start: ${e.message}; vibestd keeps running` }),
              ),
            ),
          )
        }),
    } satisfies Handlers
  })
