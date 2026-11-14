import {
  cliHeaders,
  DAEMON_START_TIMEOUT,
  connect,
  described,
  importCheck,
  type VibestClient,
  readPing,
  startDaemon,
  stopByHand,
} from "@vibest/client/client"
import { PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import {
  DaemonBusy,
  DaemonStopping,
  Forbidden,
  InvalidCaller,
  type Ping,
  ProtocolRejected,
  WrongInstance,
} from "@vibest/protocol/rpc"
import { Layout, VibestCommand, shellQuote } from "@vibest/schema/layout"
import { NoSuchSession } from "@vibest/schema/session"
import { Cause, Console, Duration, Effect, Exit, Option, Path, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, type RpcClientError } from "effect/rpc"

import { askYesNo, interactive } from "./ask.ts"

export const ReplaceOutcome = Schema.Literals(["declined", "busy", "unchanged", "unknown", "other"])

export class ReplaceFailed extends Schema.TaggedError<ReplaceFailed>()("ReplaceFailed", {
  outcome: ReplaceOutcome,
  message: Schema.String,
}) {}

const REFUSALS = [
  Forbidden,
  WrongInstance,
  DaemonBusy,
  DaemonStopping,
  ProtocolRejected,
  InvalidCaller,
  NoSuchSession,
] as const
type Refusal = InstanceType<(typeof REFUSALS)[number]>
const isRefusal = (e: unknown): e is Refusal => REFUSALS.some((c) => e instanceof c)
type StopError = Effect.Error<ReturnType<VibestClient["Daemon.Stop"]>>
const _stopErrorsClassified: [Exclude<StopError, Refusal | RpcClientError.RpcClientError>] extends [never]
  ? true
  : never = true

export const compareVersions = (a: string, b: string) => {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/\+.*/, "").split(/-(.*)/)
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === q) continue
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (m && n) return Number(p) - Number(q)
    return m !== n ? (m ? -1 : 1) : p < q ? -1 : 1
  }
  return 0
}

const FIRST_VERSION_RESTARTABLE_WITH_AGENTS = "0.0.1-beta.10"

export interface Timing {
  readonly reply: Duration.Duration
  readonly observe: Duration.Duration
}
const TIMING: Timing = {
  reply: Duration.seconds(55),
  observe: Duration.seconds(15),
}

export interface Target {
  readonly version: string
  readonly command: ReadonlyArray<string>
}

const quoted = (argv: ReadonlyArray<string>) => argv.map(shellQuote).join(" ")

export const versionOf = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const out = yield* spawner.string(ChildProcess.make(argv[0]!, [...argv.slice(1), "--version"], { stdin: "ignore" }))
    const version = /\bv?(\d+\.\d+\.\d+\S*)\s*$/.exec(out.trim())?.[1]
    return version ?? `unreadable (${JSON.stringify(out.trim().slice(0, 80))})`
  }).pipe(
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed("unreadable (no answer in 15s)") }),
    Effect.catch((e) => Effect.succeed(`unreadable (${e.message})`)),
  )

export const replaceAnyway = (socket: string, pid: number | undefined, next: string) =>
  `To go on anyway: stop vibestd with \`kill -TERM ${pid ?? "<pid in vibestd.pid>"}\`, wait until \`vibest status\` shows it not running on ${socket}, do what is said above, then run: ${next}`

const isTarget = (ping: Ping, old: Ping, target: Target) =>
  ping.instance !== undefined &&
  ping.instance !== old.instance &&
  ping.version === target.version &&
  ping.command?.join("\0") === target.command.join("\0")

export const replaceDaemon = (target: Target, timing: Timing = TIMING) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const fail = (outcome: typeof ReplaceOutcome.Type, message: string) =>
      Effect.fail(new ReplaceFailed({ outcome, message }))
    const old = Option.getOrUndefined(yield* readPing(layout.socket))
    if (!old)
      return yield* fail(
        "unchanged",
        `no vibestd answers on ${layout.socket} (not running, or not reachable); nothing was stopped. To start one: vibest daemon`,
      )
    if (old.protocol === undefined || old.instance === undefined)
      return yield* fail(
        "unchanged",
        `${described(old.version, old)} cannot be asked to stop by this vibest (it predates Daemon.Stop). ${stopByHand(layout.socket, old.pid)}`,
      )
    const reported = yield* versionOf(target.command)
    if (reported !== target.version)
      return yield* fail(
        "unchanged",
        `\`${quoted(target.command)} --version\` reports ${reported}, not ${target.version}; vibestd was not stopped`,
      )
    const cannot = yield* importCheck(target.command)
    if (cannot !== undefined)
      return yield* fail(
        "unchanged",
        `vibest ${target.version} (${quoted(target.command)}) cannot take over: ${cannot}. ${described(old.version, old)} was not stopped and keeps working.${/SchemaMismatch/.test(cannot) ? ` ${replaceAnyway(layout.socket, old.pid, "vibest daemon")}` : ""}`,
      )
    const samePath = old.command !== undefined && quoted(old.command) === quoted(target.command)
    if (!samePath)
      yield* Console.log(
        `running: ${old.command ? quoted(old.command) : "command unknown"}\nnew:     ${quoted(target.command)}`,
      )
    if (!(yield* interactive))
      return yield* fail("unchanged", "replacing vibestd needs a yes on a terminal; nothing was stopped")
    const quietOnly =
      old.version === undefined || compareVersions(old.version, FIRST_VERSION_RESTARTABLE_WITH_AGENTS) < 0
    const question = quietOnly
      ? `Replace vibestd ${old.version || "unknown"} (pid ${old.pid ?? "unknown"}) with ${target.version}? This old vibestd refuses while any agent is open. [y/N]: `
      : `Replace vibestd ${old.version || "unknown"} (pid ${old.pid ?? "unknown"}) with ${target.version}? Agents keep running. [y/N]: `
    if (!(yield* askYesNo(question))) return yield* fail("declined", "not confirmed; nothing was stopped")

    const path = yield* Path.Path
    const reply = yield* RpcClient.withHeaders(
      connect(layout.socket).pipe(Effect.flatMap((c) => c["Daemon.Stop"]({ instance: old.instance! }))),
      { ...cliHeaders(path.resolve(".")), [PROTOCOL_HEADER]: String(old.protocol) },
    ).pipe(Effect.scoped, Effect.exit, Effect.timeoutOption(timing.reply))
    if (Option.isNone(reply))
      yield* Console.log(`No reply to Stop within ${Duration.format(timing.reply)}; watching vibestd instead.`)
    else if (Exit.isFailure(reply.value)) {
      const e = Option.getOrUndefined(Cause.findErrorOption(reply.value.cause))
      if (e !== undefined && isRefusal(e)) return yield* fail(e._tag === "DaemonBusy" ? "busy" : "unchanged", e.message)
      yield* Console.log(
        `The reply to Stop was lost or could not be read (${e?._tag ?? "defect"}); watching vibestd instead.`,
      )
    }

    const after = yield* readPing(layout.socket).pipe(
      Effect.repeat({
        until: (p) => Option.isNone(p) || p.value.instance !== old.instance,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(timing.observe),
    )
    if (Option.isNone(after))
      return yield* fail(
        "unknown",
        `vibestd instance ${old.instance} still answers ${Duration.format(timing.observe)} after its Stop was sent; it was not stopped, or is still stopping. Stop was not sent again and nothing else was done; see vibest status`,
      )
    const started = Option.isNone(after.value)
    if (started)
      yield* startDaemon.pipe(
        Effect.provideService(VibestCommand, target.command),
        Effect.catchTag("DaemonUnavailable", (e) =>
          fail(
            "unknown",
            `the old vibestd stopped answering, but the new one did not come up: ${e.message}. ${old.command && !samePath ? `To run the old one again: ${quoted(old.command)} daemon` : `See ${layout.home}/vibestd.log; once that is fixed: vibest daemon`}`,
          ),
        ),
      )
    const now = (yield* readPing(layout.socket).pipe(
      Effect.repeat({
        until: (p) => Option.isSome(p) && p.value.instance !== old.instance,
        schedule: Schedule.spaced("200 millis"),
      }),
      Effect.timeoutOption(DAEMON_START_TIMEOUT),
      Effect.map(Option.flatten),
    )).pipe(Option.getOrUndefined)
    if (!now)
      return yield* fail("unknown", `the old vibestd stopped answering, and nothing answers on ${layout.socket} now`)
    if (!isTarget(now, old, target))
      return yield* fail(
        "other",
        `the old vibestd stopped answering${started ? `, and vibest started ${quoted(target.command)}` : ""}; ${described(now.version, now)}, instance ${now.instance ?? "unknown"}, answers, not vibest ${target.version} (${quoted(target.command)}) as asked${started ? "" : " (vibest did not start it)"}. vibest does nothing more`,
      )
    yield* Console.log(
      `vibestd ${now.version} (pid ${now.pid}) is running on ${layout.socket}, instance ${now.instance}.`,
    )
  })
