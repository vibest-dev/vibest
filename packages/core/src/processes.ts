import { type Captured, capture } from "@vibest/plugin"
import { Context, Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { LayerNode } from "./effect/layer-node.ts"

export type Liveness = "exited" | "alive" | "unknown"

export const livenessOf = (probe: () => void): Liveness => {
  try {
    probe()
    return "alive"
  } catch (e) {
    const code = (e as { readonly code?: unknown } | null)?.code
    return code === "ESRCH" ? "exited" : code === "EPERM" ? "alive" : "unknown"
  }
}

export const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0

export interface ProcessPlatform {
  readonly liveness: (pid: number) => Liveness
  readonly terminate: (pid: number) => void
  readonly pid: number
  readonly uid: number | undefined
}

export const LSOF_TIMEOUT = Duration.seconds(10)
export const LSOF_KILL_AFTER = Duration.seconds(1)

export const lsofArgs = (uid: number) => ["+w", "-a", "-u", String(uid), "-d", "cwd", "-Fpfn0"]

export type ProcessRun = Captured

export class Processes extends Context.Service<
  Processes,
  {
    readonly liveness: (pid: number) => Effect.Effect<Liveness>
    readonly terminate: (pid: number) => Effect.Effect<"sent" | "denied">
    readonly cwdUsers: (dirs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<number> | undefined>
  }
>()("vibest/Processes") {
  static readonly layer = (platform: ProcessPlatform) =>
    Layer.effect(
      Processes,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const lsof = (uid: number) =>
          runFor("lsof", lsofArgs(uid), LSOF_TIMEOUT).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
        return Processes.of({
          liveness: (pid) => Effect.sync(() => (validPid(pid) ? platform.liveness(pid) : "unknown")),
          terminate: (pid) =>
            Effect.sync(() => {
              if (!validPid(pid) || pid === platform.pid) return "denied" as const
              try {
                platform.terminate(pid)
                return "sent" as const
              } catch (e) {
                return (e as { readonly code?: unknown }).code === "ESRCH" ? ("sent" as const) : ("denied" as const)
              }
            }),
          cwdUsers: (dirs) =>
            platform.uid === undefined || !Number.isInteger(platform.uid) || platform.uid < 0
              ? Effect.succeed(undefined)
              : lsof(platform.uid).pipe(Effect.map((run) => cwdHolders(run, platform.pid, dirs))),
        })
      }),
    )

  static readonly node = LayerNode.unbound(Processes)
}

export const runFor = (command: string, args: ReadonlyArray<string>, timeout: Duration.Input) =>
  capture(command, args, { timeout, forceKillAfter: LSOF_KILL_AFTER }).pipe(Effect.orElseSucceed(() => undefined))

export const cwdHolders = (
  run: ProcessRun | undefined,
  self: number,
  dirs: ReadonlyArray<string>,
): ReadonlyArray<number> | undefined => {
  if (run === undefined || run.exitCode !== 0 || run.stderr.trim() !== "") return undefined
  const holders = new Set<number>()
  let pid: number | undefined
  let file: "cwd" | undefined
  let canary = false
  let unnamed = false
  for (const set of run.stdout.split("\n")) {
    if (set === "") continue
    const fields = set.split("\0")
    if (fields.pop() !== "") return undefined
    for (const field of fields) {
      const value = field.slice(1)
      if (field[0] === "p") {
        if (file !== undefined || unnamed) return undefined
        unnamed = true
        pid = Number(value)
        if (!validPid(pid) || String(pid) !== value) return undefined
      } else if (field[0] === "f") {
        if (pid === undefined || file !== undefined || value !== "cwd") return undefined
        file = "cwd"
      } else if (field[0] === "n") {
        if (pid === undefined || file === undefined) return undefined
        if (DIAGNOSTIC.test(value)) return undefined
        if (pid === self) canary = true
        if (dirs.some((dir) => mayBeIn(value, dir))) holders.add(pid)
        file = undefined
        unnamed = false
      } else return undefined
    }
  }
  if (file !== undefined || unnamed || !canary) return undefined
  return [...holders]
}

const DIAGNOSTIC = / \((readlink|stat): /

const mayBeIn = (name: string, dir: string) => {
  const base = dir.replace(/\/+$/, "")
  const deleted = name.replace(/ \(deleted\)$/, "")
  const escape = deleted.search(/[\\^]/)
  if (escape >= 0) {
    const known = deleted.slice(0, escape)
    const target = `${base}/`
    return target.startsWith(known) || known.startsWith(target)
  }
  return deleted === base || deleted.startsWith(`${base}/`)
}
