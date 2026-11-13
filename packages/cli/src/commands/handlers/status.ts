import { readPing } from "@vibest/client/client"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import * as Daemon from "@vibest/server/daemon"
import { Effect, Option } from "effect"

import { json } from "../../caller.ts"
import * as Runtime from "../../framework/runtime.ts"
import { noticeFrom } from "../../update.ts"
import { VERSION } from "../../version.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.status, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const info = yield* Daemon.readDaemonInfo(layout.daemonInfo)
    const ping = yield* readPing(layout.socket)
    yield* noticeFrom(Effect.succeed(ping))
    yield* json({
      client: { version: VERSION, command: yield* VibestCommand },
      daemon: Option.match(ping, {
        onNone: () => ({ status: "not running", socket: layout.socket }),
        onSome: (p) => ({
          status: "running",
          pid: p.pid ?? null,
          instance: p.instance ?? null,
          command: p.command ?? null,
          startedAt: p.startedAt ?? null,
          version: p.version,
          sameVersion: p.version === VERSION,
          protocol: p.protocol ?? null,
          update: p.update ?? null,
          socket: layout.socket,
          recordedPid: Option.getOrNull(Option.map(info, (i) => i.pid)),
        }),
      }),
      runtimes: Option.getOrNull(Option.map(ping, (p) => p.runtimes ?? null)),
    })
  }),
)
