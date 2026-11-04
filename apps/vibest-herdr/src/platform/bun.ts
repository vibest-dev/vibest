import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"

// vibest on Bun: the only file under src/ that names a runtime. Reached through the `#platform` import, which
// package.json `imports` resolves by condition ("bun" here); another runtime adds a condition and a sibling file.
import { BunHttpServer, BunRuntime, BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SocketConnector } from "@vibest/client/socket-connector"
import { inspectSchema, SchemaMismatch, SQL_NAMES } from "@vibest/core/db"
import { CLAUDE_CREDENTIALS, claudeCredentialsFile, type KeychainPlatform, securityArgs } from "@vibest/core/keychain"
import { type Candidate, type PluginLoader } from "@vibest/core/plugins"
import { type Liveness, livenessOf, type ProcessPlatform, validPid } from "@vibest/core/processes"
import { UserPlatform } from "@vibest/core/system-prompt"
import * as VibestPlugin from "@vibest/plugin"
import { harnessChoicePlugin } from "@vibest/plugin-harness-choice"
import { choicePlugin, type ConfiguredRuntime } from "@vibest/runtime-herdr/choice"
import { plugin as runtimeHerdrPlugin } from "@vibest/runtime-herdr/plugin"
import type { Host } from "@vibest/server/daemon"
import * as effect from "effect"
import { Effect, Layer, Stdio, Stream } from "effect"
import * as HerdrBun from "effect-herdr-sdk/bun"

import { graph, keyLocalImports, load, watch } from "./plugin-source.ts"

/**
 * Bun's Stdio, except a finished read of stdin unrefs it: a TTY stdin that was read stays referenced even after the
 * stream ends or `pause()`, so `vibest` would never exit after a `[y/N]` answer. A later read still works.
 */
const stdio = Layer.effect(
  Stdio.Stdio,
  Effect.map(Stdio.Stdio, (bun) =>
    Stdio.make({
      ...bun,
      stdin: Stream.ensuring(
        bun.stdin,
        Effect.sync(() => process.stdin.unref?.()),
      ),
    }),
  ),
).pipe(Layer.provide(BunServices.layer))

/** This user's id and an lstat that does not follow a link: the system prompt's temporary directory without TMPDIR. */
const user = Layer.succeed(UserPlatform, {
  uid: process.getuid?.(),
  lstat: async (file) => {
    const st = await fsPromises.lstat(file)
    return { symlink: st.isSymbolicLink(), directory: st.isDirectory(), uid: st.uid, mode: st.mode }
  },
})

/** FileSystem, Path, Crypto, ChildProcessSpawner, Stdio, Terminal, the socket connectors (vibest's and herdr's), the user. */
export const services = Layer.mergeAll(
  BunServices.layer,
  stdio,
  HerdrBun.layerSocketConnector,
  Layer.succeed(SocketConnector, (endpoint) => BunSocket.makeNet({ path: endpoint })),
  user,
)

/** The Bun SQLite driver (sql-sqlite-bun): a writable transaction is BEGIN IMMEDIATE and busy_timeout is 5000. */
const sqliteLayer = (filename: string, readonly: boolean) =>
  SqliteClient.layer({ filename, readonly, disableWAL: true, ...SQL_NAMES })

const PRIVATE_FILE = 0o600

/** Create a missing database as 0600, then force that mode on the database and any existing -wal / -shm. SQLite copies the database mode onto -wal and -shm it creates later. */
const privateDatabase = (filename: string) =>
  Effect.tryPromise(async () => {
    // Mode "a" creates a missing file and never truncates an existing one; the chmod right after forces the mode either way.
    await (await fsPromises.open(filename, "a", PRIVATE_FILE)).close()
    await fsPromises.chmod(filename, PRIVATE_FILE)
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await fsPromises.chmod(filename + suffix, PRIVATE_FILE)
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error
      }
    }
  })

/** `inspectSchema` on a read-only connection to `filename`; a refusal names the file. */
const inspectFile = (filename: string) =>
  inspectSchema.pipe(
    Effect.provide(sqliteLayer(filename, true)),
    Effect.scoped,
    Effect.mapError((e) =>
      e instanceof SchemaMismatch
        ? new SchemaMismatch({
            version: e.version,
            applicationId: e.applicationId,
            ...(e.detail === undefined ? {} : { detail: e.detail }),
            file: filename,
          })
        : e,
    ),
  )

/**
 * The SqlClient `Db` runs on (bun:sqlite). An existing file is judged by `inspectSchema` on a read-only connection,
 * which can see committed WAL frames and does not checkpoint. A mismatch fails before any writable open, so the
 * database and WAL are not rewritten. The WAL index (-shm) may still change; that is not a byte guarantee. A missing
 * file is created mode 0600 and then opened writable. WAL mode stays off until `Db` accepts the file.
 */
export const sqlite = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (filename !== ":memory:") {
        const existed = yield* Effect.promise(() => Bun.file(filename).exists())
        yield* privateDatabase(filename)
        if (existed) yield* inspectFile(filename)
      }
      return sqliteLayer(filename, false)
    }),
  )

/** Read-only: an existing database at `filename` is this vibest's schema (a missing one is fine). Writes nothing. */
export const checkDatabase = (filename: string) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(filename).exists()))) return
    yield* inspectFile(filename)
  }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

export const runMain = BunRuntime.runMain

let mapped = false

/**
 * Plugins import `effect` and `@vibest/plugin`; inside the compiled binary nothing resolves them, and a copy next to the
 * plugin would be a second effect instance. Map them to vibestd's own modules (plugins.md §2): `effect/X` is `effect.X`
 * for every top-level module the root namespace exports. The same setup keys each load's local imports (plugin-source.ts).
 */
export const plugins: PluginLoader["Service"] = {
  prepare: Effect.sync(() => {
    if (mapped) return
    mapped = true
    Bun.plugin({
      name: "vibest-plugin-runtime",
      setup(build) {
        const object = (exports: object) => () => ({
          exports: exports as Record<string, unknown>,
          loader: "object" as const,
        })
        build.module("effect", object(effect))
        build.module("@vibest/plugin", object(VibestPlugin))
        for (const [name, value] of Object.entries(effect)) {
          if (/^[A-Z]/.test(name) && typeof value === "object" && value !== null)
            build.module(`effect/${name}`, object(value))
        }
        keyLocalImports(build)
      },
    })
  }),
  parseJsonc: (text) => Bun.JSONC.parse(text),
  graph,
  load,
  watch,
}

/** Signal 0 to a PID the caller validated (a positive integer): it tests for the process, it does not signal it. */
export const liveness = (pid: number): Liveness => livenessOf(() => process.kill(pid, 0))

/** SIGTERM to one positive PID. Never 0 or negative: that would signal this process's group, or every process. */
const terminate = (pid: number) => {
  if (!validPid(pid)) return
  process.kill(pid, "SIGTERM")
}

const processes: ProcessPlatform = { liveness, terminate, pid: process.pid, uid: process.getuid?.() }

/** `security -w` prints the password and a newline. Empty, non-zero, or a timeout is unreadable — never logged. */
const securityPassword = (service: string) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([...securityArgs(service)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => proc.kill(), 10_000)
    try {
      const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      const value = text.replace(/\n$/, "")
      return code === 0 && value !== "" ? value : undefined
    } finally {
      clearTimeout(timer)
    }
  }).pipe(Effect.orElseSucceed(() => undefined))

const credentialFile = (file: string) =>
  Effect.promise(async () => {
    const stored = Bun.file(file)
    return (await stored.exists()) ? await stored.text() : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

/** macOS keychain. Elsewhere, Claude's credential file (same JSON); Cursor's Linux location is unknown. */
const keychain: KeychainPlatform = {
  password: (service) =>
    process.platform === "darwin"
      ? securityPassword(service)
      : service === CLAUDE_CREDENTIALS && process.env.HOME
        ? credentialFile(claudeCredentialsFile(process.env.HOME))
        : Effect.succeed(undefined),
}

/** libc's flock(2): advisory, whole-file, held by the open file description, dropped by the kernel when the process dies. */
const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const LOCK_EX_NB = 2 | 4

/**
 * vibestd.pid is both its record and its start lock: flock on the file itself, so readers still read it while it is held,
 * and a killed vibestd leaves no stale lock (the kernel drops it). Written in place, never replaced: a new inode would be
 * an unlocked file. Never unlinked either (a contender may have the old inode open); emptied on release.
 * ponytail: flock -1 is taken as "held by another process" without reading errno; open failures are still errors.
 */
const lock: Host["lock"] = (file) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600)
        if (libc.symbols.flock(fd, LOCK_EX_NB) === 0) return fd
        fs.closeSync(fd)
        return undefined
      },
      catch: (e) => e as Error,
    }),
    (fd) =>
      Effect.sync(() => {
        if (fd === undefined) return
        try {
          fs.ftruncateSync(fd, 0)
        } finally {
          fs.closeSync(fd)
        }
      }),
  ).pipe(
    Effect.map((fd) =>
      fd === undefined
        ? undefined
        : (text: string) =>
            Effect.try({
              try: () => {
                fs.ftruncateSync(fd, 0)
                fs.writeSync(fd, text, 0)
              },
              catch: (e) => e as Error,
            }),
    ),
  )

/** vibest.json's top-level `runtime` key (runtime-port §4), read again per start so an edit applies to the next one:
 * the same file and parser plugin-sources reads it with, at Layout's home (VIBEST_HOME, default $HOME/.vibest). */
const configuredRuntime: ConfiguredRuntime = () =>
  Effect.sync(() => {
    try {
      const home =
        process.env["VIBEST_HOME"] ?? (process.env["HOME"] ? path.join(process.env["HOME"], ".vibest") : undefined)
      if (home === undefined) return undefined
      const runtime = (
        plugins.parseJsonc(fs.readFileSync(path.join(home, "vibest.json"), "utf8")) as { runtime?: unknown }
      ).runtime
      return typeof runtime === "string" && runtime !== "" ? runtime : undefined
    } catch {
      return undefined
    }
  })

/** The builtin plugins, before user plugins: the default harness choice (architecture.md §9), then the runtime
 * plugins (runtime-port.md §2). */
const builtinPlugins: ReadonlyArray<Candidate> = [
  { source: "builtin:harness-choice", revision: "harness-choice", options: {}, plugin: harnessChoicePlugin },
  { source: "builtin:runtime-herdr", revision: "runtime-herdr", options: {}, plugin: runtimeHerdrPlugin },
  {
    source: "builtin:runtime-choice",
    revision: "runtime-choice",
    options: {},
    plugin: choicePlugin(configuredRuntime),
  },
]

/** What vibestd needs from the runtime beyond `services`; the product adds the terminal runtime (main.ts). */
export const daemon: Omit<Host, "runtime"> = {
  sqlite,
  socketServer: (path) => BunSocketServer.layer({ path }),
  httpServer: (path) => BunHttpServer.layerServer({ unix: path }),
  plugins,
  builtinPlugins,
  processes,
  keychain,
  lock,
  checkDatabase,
}

/** argv that runs this vibest again: the binary itself when compiled (`bun build --compile`), else `bun <script>`. */
export const selfCommand: ReadonlyArray<string> =
  process.argv[1] === undefined || process.argv[1].startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, process.argv[1]]

/** Replace this process with `file` (looked up on PATH like a shell does), adding `env` to the current environment. */
export const exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => {
  process.execve!(Bun.which(file) ?? file, [file, ...args], { ...process.env, ...env })
}
