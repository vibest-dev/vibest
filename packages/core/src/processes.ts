// What vibest can tell about processes when it removes a session (SPEC §8.6a): whether a PID it recorded still exists, and
// which of this user's processes have their working directory in the worktree. vibest never signals a process it found
// or recorded (vibestd is replaced through Daemon.Stop, never a signal); herdr's pane.close does that for
// the pane it closes. The only process that listing ends is its own lsof helper. `terminate` is SIGTERM to one
// harness pid, never its group: the one a main agent's own `vibest` reported before it exec'd the harness
// (Project.StopCoordinator), or the one an agent's integration reported (a restart, a usage-limit move).
import { Context, Duration, Effect, Layer, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** Signal 0's answer: ESRCH = exited, EPERM = alive, anything else = unknown. */
export type Liveness = "exited" | "alive" | "unknown"

/** Signal 0's answer from `probe` (which sends it and throws what the system said): ESRCH exited, EPERM alive, else unknown. */
export const livenessOf = (probe: () => void): Liveness => {
  try {
    probe()
    return "alive"
  } catch (e) {
    const code = (e as { readonly code?: unknown } | null)?.code
    return code === "ESRCH" ? "exited" : code === "EPERM" ? "alive" : "unknown"
  }
}

/** A PID vibest may ask about: a positive integer, never 0 or -1 (a process group, every process). */
export const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0

/** What the runtime gives (src/platform): signal 0, SIGTERM to one process, and vibestd's own PID and numeric user id (undefined: none). */
export interface ProcessPlatform {
  readonly liveness: (pid: number) => Liveness
  /** SIGTERM to the one process `pid` (positive; never a group). Throws what the system said. */
  readonly terminate: (pid: number) => void
  readonly pid: number
  readonly uid: number | undefined
}

export const LSOF_TIMEOUT = Duration.seconds(10)
/** After the timeout's SIGTERM, how long lsof's own process group has before SIGKILL. */
export const LSOF_KILL_AFTER = Duration.seconds(1)

/**
 * lsof's arguments: warnings on (`+w`, whatever the build's default), AND (`-a`) of this user's processes (`-u`,
 * numeric) and their cwd. `f` is requested: Linux lsof omits the fd unless `-F` asks for it, and macOS prints it either way.
 */
export const lsofArgs = (uid: number) => ["+w", "-a", "-u", String(uid), "-d", "cwd", "-Fpfn0"]

/** What one lsof run returned; undefined when it did not finish (missing, failed to start, timed out). */
export interface LsofRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class Processes extends Context.Service<
  Processes,
  {
    /** Signal 0 to `pid`. A reused PID reads as alive: that can only keep more, never signal it. */
    readonly liveness: (pid: number) => Effect.Effect<Liveness>
    /** SIGTERM to one process. `sent` includes already gone (ESRCH). `denied` is any other failure, or an invalid PID. */
    readonly terminate: (pid: number) => Effect.Effect<"sent" | "denied">
    /**
     * PIDs of this user's processes whose cwd is in one of `dirs` (a directory and its other spellings, e.g. its real
     * path); undefined when the listing cannot be trusted to be complete.
     */
    readonly cwdUsers: (dirs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<number> | undefined>
  }
>()("vibest/Processes") {
  /** `lsof +w -a -u <uid> -d cwd -Fpfn0`, an argument array (no shell); see `cwdHolders` for what counts as an answer. */
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
}

/**
 * Runs `command` (vibestd's own helper, in its own process group) to the end; undefined if it fails to start or does not
 * finish within `timeout`. Then its group gets SIGTERM and, still there after LSOF_KILL_AFTER, SIGKILL; the run ends
 * once the helper exited. A helper stuck in uninterruptible kernel I/O cannot be reaped, even by SIGKILL, and holds the
 * run until it returns.
 */
export const runFor = (command: string, args: ReadonlyArray<string>, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { forceKillAfter: LSOF_KILL_AFTER }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    return { exitCode, stdout, stderr } satisfies LsofRun
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * The holders of `dirs` in one lsof run, or undefined unless the run is trustworthy: it finished with exit 0 and
 * nothing on stderr (lsof's warnings mean a partial listing), every set is a well-formed `p` or `f cwd` + `n` set, no
 * name is lsof's diagnostic in place of a path, and vibestd's own process (`self`) is in it with its cwd. That canary is
 * a sanity check against an empty or broken listing, not a proof that the listing is complete.
 * Names lsof could not print as they are (`\n`, `^X`, `\xNN` escapes) and `(deleted)` working directories are matched
 * conservatively: anything they could stand for that is in `dirs` counts as a holder.
 */
export const cwdHolders = (
  run: LsofRun | undefined,
  self: number,
  dirs: ReadonlyArray<string>,
): ReadonlyArray<number> | undefined => {
  if (run === undefined || run.exitCode !== 0 || run.stderr.trim() !== "") return undefined
  const holders = new Set<number>()
  let pid: number | undefined
  let file: "cwd" | undefined
  let canary = false
  /** A process whose cwd has not been named yet: one lsof could not read could be anywhere. */
  let unnamed = false
  // With the 0 field character every field ends in NUL and every process or file set in NL.
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
        // A cwd lsof could not read (Linux: `/proc/<pid>/cwd (readlink: …)`, `<path> (stat: …)`, exit 0 and nothing on
        // stderr) could be the target: the whole listing is unknown.
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

/** lsof's diagnostic suffixes for a name it could not resolve (only the stable prefix: the reason is localized). */
const DIAGNOSTIC = / \((readlink|stat): /

/** Whether lsof's name `name` may be `dir` or a path under it. */
const mayBeIn = (name: string, dir: string) => {
  const base = dir.replace(/\/+$/, "")
  const deleted = name.replace(/ \(deleted\)$/, "")
  const escape = deleted.search(/[\\^]/)
  // Up to its first escape the name is literal; past it, it could be anything.
  if (escape >= 0) {
    const known = deleted.slice(0, escape)
    const target = `${base}/`
    return target.startsWith(known) || known.startsWith(target)
  }
  return deleted === base || deleted.startsWith(`${base}/`)
}
