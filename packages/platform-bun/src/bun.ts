import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { BunHttpServer, BunRuntime, BunServices, BunSocket } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { HttpConnector } from "@vibest/client/client"
import { stdioSocket } from "@vibest/client/pipe"
import { SocketConnector } from "@vibest/client/socket-connector"
import { nodeUnixHttpClient } from "@vibest/client/unix-http.node"
import { App } from "@vibest/core/app"
import { SQL_NAMES } from "@vibest/core/database/db"
import { DatabaseOpenFailed, inspectSchema, SchemaMismatch } from "@vibest/core/database/db-schema"
import { checkLedger, migrations } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Identity, MACHINE_ID_FILES, readHostId } from "@vibest/core/identity"
import { Builtins, builtinsNode, PluginLoader, pluginLoaderNode } from "@vibest/core/plugin"
import { type Liveness, livenessOf, Processes, validPid } from "@vibest/core/processes"
import { Runtimes } from "@vibest/core/runtimes"
import { UserPlatform } from "@vibest/core/system-prompt"
import * as HerdrBun from "@vibest/herdr-sdk/bun"
import * as VibestPlugin from "@vibest/plugin"
import { pre } from "@vibest/plugin-builtins"
import * as VibestPluginEffect from "@vibest/plugin/effect"
import * as VibestPluginHost from "@vibest/plugin/host"
import { messageOf } from "@vibest/schema/error"
import { Layout, UserUid } from "@vibest/schema/layout"
import { type Host, LockFailed } from "@vibest/server/daemon"
import { Load } from "@vibest/server/machine/load"
import { Machines } from "@vibest/server/machine/machines"
import * as Server from "@vibest/server/server"
import * as Ui from "@vibest/server/ui"
import { UpdateCheck } from "@vibest/server/update-check"
import { LayerNode } from "@vibest/util/layer-node"
import * as effect from "effect"
import {
  Cause,
  Duration,
  Effect,
  type FileSystem,
  Layer,
  Predicate,
  Schedule,
  Schema,
  type Scope,
  Stdio,
  Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { FetchHttpClient, type HttpClient } from "effect/http"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { SqlClient, SqlError } from "effect/sql"

import { layer as hostSample } from "./host-sample.ts"
import { trimLog } from "./log-file.ts"
import { graph, pluginLoads, packageName, watch } from "./plugin-source.ts"

const readOnDemand = (handle: fsPromises.FileHandle) =>
  Effect.flatMap(
    Effect.promise(() => handle.read(Buffer.alloc(4096)).catch(() => ({ bytesRead: 0, buffer: Buffer.alloc(0) }))),
    ({ bytesRead, buffer }) =>
      bytesRead === 0 ? Cause.done() : Effect.succeed([buffer.subarray(0, bytesRead)] as const),
  )

const terminalUntilGone = Stream.scoped(
  Stream.fromPull(
    Effect.map(
      Effect.acquireRelease(
        Effect.promise(() => fsPromises.open("/dev/stdin")),
        (handle) => Effect.promise(() => handle.close()),
      ),
      readOnDemand,
    ),
  ),
)

const unrefStdio = Layer.effect(
  Stdio.Stdio,
  Effect.map(Stdio.Stdio, (bun) =>
    Stdio.make({
      ...bun,
      stdin: Stream.suspend(() =>
        process.stdin.isTTY
          ? terminalUntilGone
          : Stream.ensuring(
              bun.stdin,
              Effect.sync(() => process.stdin.unref?.()),
            ),
      ),
    }),
  ),
).pipe(Layer.provide(BunServices.layer))

const user = Layer.succeed(UserPlatform, {
  uid: process.getuid?.(),
  lstat: async (file) => {
    const st = await fsPromises.lstat(file)

    return { symlink: st.isSymbolicLink(), directory: st.isDirectory(), uid: st.uid, mode: st.mode }
  },
})

const platform = Layer.mergeAll(
  BunServices.layer,
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto,
  FetchHttpClient.layer,
  unrefStdio,
  HerdrBun.layerSocketConnector,
  Layer.succeed(SocketConnector.Service, (endpoint) => BunSocket.makeNet({ path: endpoint })),
  Layer.succeed(UserUid, process.getuid?.()),
  Layer.succeed(HttpConnector.Service, nodeUnixHttpClient),
  user,
)

const sqliteLayer = (filename: string, readonly: boolean) =>
  SqliteClient.layer({ filename, readonly, disableWAL: true, ...SQL_NAMES })

const PRIVATE_FILE = 0o600

const privateDatabase = (filename: string) =>
  Effect.tryPromise({
    try: async () => {
      await (await fsPromises.open(filename, "a", PRIVATE_FILE)).close()
      await fsPromises.chmod(filename, PRIVATE_FILE)

      for (const suffix of ["-wal", "-shm"]) {
        try {
          await fsPromises.chmod(filename + suffix, PRIVATE_FILE)
        } catch (error) {
          if (!Predicate.hasProperty(error, "code") || error.code !== "ENOENT") throw error
        }
      }
    },
    catch: (e) => new DatabaseOpenFailed({ file: filename, message: messageOf(e) }),
  })

const INSPECT_RETRY = Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "5 seconds" }))

const inspectFile = (filename: string, known: ReadonlySet<string> = new Set(migrations.map((m) => m.id))) =>
  inspectSchema(known).pipe(
    Effect.provide(sqliteLayer(filename, true)),
    Effect.scoped,
    Effect.retry({
      while: (error) =>
        SqlError.isSqlError(error) &&
        (Predicate.isTagged(error.reason, "LockTimeoutError") || Predicate.isTagged(error.reason, "ConnectionError")),
      schedule: INSPECT_RETRY,
    }),
    Effect.mapError((e) =>
      e instanceof SchemaMismatch
        ? new SchemaMismatch({
            version: e.version,
            applicationId: e.applicationId,
            ...(e.detail !== undefined && { detail: e.detail }),
            ...(e.older !== undefined && { older: e.older }),
            ...(e.unknownMigration !== undefined && { unknownMigration: e.unknownMigration }),
            file: filename,
          })
        : new DatabaseOpenFailed({ file: filename, message: e.message }),
    ),
  )

export const sqlite = (filename: string, known?: ReadonlySet<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (filename !== ":memory:") {
        const existed = yield* Effect.promise(() => Bun.file(filename).exists())
        yield* privateDatabase(filename)

        if (existed) yield* inspectFile(filename, known)
      }

      return sqliteLayer(filename, false)
    }),
  )

const readOnly = (filename: string) =>
  Layer.build(sqliteLayer(filename, true)).pipe(
    Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
    Effect.mapError((e) => new DatabaseOpenFailed({ file: filename, message: e.message })),
  )

export const checkDatabase: Host["checkDatabase"] = (filename) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(filename).exists()))) return

    if ((yield* inspectFile(filename)) === "empty") return
    yield* checkLedger(yield* readOnly(filename)).pipe(
      Effect.provide(Projectors.replay.pipe(Layer.provideMerge(sqliteLayer(":memory:", false)))),
      Effect.catchTag("SqlError", (e) => new DatabaseOpenFailed({ file: filename, message: e.message })),
    )
  }).pipe(Effect.scoped)

export const runMain = BunRuntime.runMain

type ModuleExports = Bun.OnLoadResultObject["exports"]

const provided = new Map<string, ModuleExports>([
  ["effect", effect],
  ["@vibest/plugin", VibestPlugin],
  ["@vibest/plugin/effect", VibestPluginEffect],
  ["@vibest/plugin/host", VibestPluginHost],
  ["effect/process/ChildProcess", ChildProcess],
  ["effect/process/ChildProcessSpawner", ChildProcessSpawner],
  ...Object.entries(effect).flatMap(([name, value]): ReadonlyArray<readonly [string, ModuleExports]> =>
    /^[A-Z]/.test(name) && Predicate.isObject(value) ? [[`effect/${name}`, value]] : [],
  ),
])

const providedPackages: ReadonlySet<string> = new Set(provided.keys().map(packageName))

export const parseJsonc = (text: string) => Schema.decodeUnknownSync(Schema.Json)(Bun.JSONC.parse(text))

export const makePluginLoader = (): PluginLoader["Service"] => {
  const { keyLocalImports, load } = pluginLoads()
  let mapped = false

  return {
    prepare: Effect.sync(() => {
      if (mapped) return
      mapped = true
      Bun.plugin({
        name: "vibest-plugin-runtime",
        setup(build) {
          const object = (exports: ModuleExports) => () => ({ exports, loader: "object" as const })

          for (const [name, value] of provided) build.module(name, object(value))
          keyLocalImports(build)
        },
      })
    }),
    parseJsonc,
    graph: (entry) => graph(entry, providedPackages),
    load,
    watch,
  }
}

const darwinLibc =
  process.platform === "darwin"
    ? dlopen("libc.dylib", {
        sysctl: {
          args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
      }).symbols
    : undefined

const CTL_KERN = 1
const KERN_PROC = 14
const KERN_PROC_PID = 1
const KINFO_PROC_BYTES = 648
const KINFO_PROC_P_STAT_AT = 36
const SZOMB = 5

const darwinZombie = (sysctl: NonNullable<typeof darwinLibc>["sysctl"], pid: number) => {
  const info = new Uint8Array(KINFO_PROC_BYTES)
  const size = new BigUint64Array([BigInt(KINFO_PROC_BYTES)])
  const query = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid])

  return (
    sysctl(query, query.length, info, size, null, 0) === 0 &&
    size[0] === BigInt(KINFO_PROC_BYTES) &&
    info[KINFO_PROC_P_STAT_AT] === SZOMB
  )
}

const linuxZombie = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")

    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")
  } catch {
    return false
  }
}

const isZombie = (pid: number) => (darwinLibc ? darwinZombie(darwinLibc.sysctl, pid) : linuxZombie(pid))

export const liveness = (pid: number): Liveness => {
  const seen = livenessOf(() => process.kill(pid, 0))

  return seen === "alive" && isZombie(pid) ? "exited" : seen
}

const terminate = (pid: number) => {
  if (!validPid(pid)) return
  process.kill(pid, "SIGTERM")
}

const processes: Processes.ProcessPlatform["Service"] = {
  liveness,
  terminate,
  pid: process.pid,
  uid: process.getuid?.(),
}

const LIBC_SPEC = {
  dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const

const LIBC_CANDIDATES =
  process.platform === "darwin"
    ? ["libc.dylib"]
    : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"]

const openLibc = () => {
  for (const name of LIBC_CANDIDATES) {
    try {
      return dlopen(name, LIBC_SPEC).symbols
    } catch {}
  }

  throw new Error(`could not open libc (tried ${LIBC_CANDIDATES.join(", ")})`)
}

const LOCK_EX_NB = 2 | 4

export const captureDaemonLog = (file: string) =>
  Effect.sync(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, "a")

    try {
      const libc = openLibc()

      if (libc.dup2(fd, 1) === -1 || libc.dup2(fd, 2) === -1) throw new Error(`dup2 ${file} failed`)
    } finally {
      fs.closeSync(fd)
    }
  })

export const restoreNormalJitPolicy = Effect.sync(() => {
  const unsafe = Bun.unsafe

  if (Predicate.hasProperty(unsafe, "setJITPolicy") && Predicate.isFunction(unsafe.setJITPolicy)) unsafe.setJITPolicy(1)
})

export const trimDaemonLog: Host["trimLog"] = (file) =>
  Effect.sync(() => {
    try {
      trimLog(file)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      fs.writeSync(2, `log trim failed: ${message}\n`)
    }
  })

const lockFailed = (file: string) => (cause: unknown) => new LockFailed({ file, message: messageOf(cause) })

export const lock: Host["lock"] = (file) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600)

        try {
          if (openLibc().flock(fd, LOCK_EX_NB) === 0) {
            fs.fchmodSync(fd, 0o600)

            return fd
          }
        } catch (cause) {
          fs.closeSync(fd)
          throw cause
        }

        fs.closeSync(fd)

        return undefined
      },
      catch: lockFailed(file),
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
              catch: lockFailed(file),
            }),
    ),
  )

const ioreg = Effect.tryPromise((signal) =>
  new Response(
    Bun.spawn(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal,
    }).stdout,
  ).text(),
)

const hostId = readHostId(
  process.platform === "darwin"
    ? { ioreg, files: [] }
    : { files: process.platform === "linux" ? MACHINE_ID_FILES : [] },
).pipe(Effect.provide(BunServices.layer))

const theExitSaysWhyTheLineEnded = () => undefined

const transport: Machines.MachineTransport["Service"] = (argv) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }),
    (proc) => Effect.sync(() => proc.kill()),
  ).pipe(
    Effect.flatMap((proc) => {
      const stderr = new Response(proc.stderr).text().catch(() => "")
      const exited = Effect.promise(async () => ({ code: (await proc.exited) ?? undefined, stderr: await stderr }))

      const writable = new WritableStream<Uint8Array>({
        write: (chunk) =>
          Promise.resolve()
            .then(async () => {
              proc.stdin.write(chunk)
              await proc.stdin.flush()
            })
            .catch(theExitSaysWhyTheLineEnded),
        close: async () => {
          await proc.stdin.end()
        },
      })

      return Effect.map(stdioSocket({ readable: proc.stdout, writable }), (socket) => ({ socket, exited }))
    }),
  )

const dropEnv = (names: ReadonlyArray<string>) => {
  for (const name of names) delete process.env[name]
}

export const services = platform

export const httpServer = (path: string) =>
  BunHttpServer.layerServer({ unix: path, idleTimeout: 0, gracefulShutdownTimeout: Duration.zero })

const platformNode = LayerNode.make({ name: "vibest/Platform", layer: platform, deps: [] })

export const replacements: LayerNode.Replacements = [
  PlatformNode.fileSystem.replace(platformNode),
  PlatformNode.path.replace(platformNode),
  PlatformNode.digest.replace(platformNode),
  PlatformNode.secureRandom.replace(platformNode),
  PlatformNode.childProcessSpawner.replace(platformNode),
  PlatformNode.sqlClientLayer.replace(
    LayerNode.make({
      name: "vibest/Sqlite",
      layer: Layer.unwrap(
        Effect.map(Layout, (layout) => Layer.succeed(PlatformNode.SqlClientLayer, sqlite(layout.database))),
      ),
      deps: [PlatformNode.layout],
    }),
  ),
  Machines.machineTransportNode.replace(Layer.succeed(Machines.MachineTransport, transport)),
  pluginLoaderNode.replace(Layer.sync(PluginLoader, makePluginLoader)),
  builtinsNode.replace(
    LayerNode.make({
      name: "vibest/Builtins",
      layer: Layer.effect(
        Builtins,
        Effect.flatMap(Layout, (layout) => pre(layout.home, parseJsonc)),
      ),
      deps: [
        PlatformNode.fileSystem,
        PlatformNode.path,
        PlatformNode.digest,
        PlatformNode.layout,
        PlatformNode.childProcessSpawner,
      ],
    }),
  ),
  Runtimes.hostEnvNode.replace(Layer.succeed(Runtimes.HostEnv, { drop: dropEnv })),
  Processes.processPlatformNode.replace(Layer.succeed(Processes.ProcessPlatform, processes)),
  Server.httpServerLayer.replace(
    LayerNode.make({
      name: "vibest/HttpServer/unix",
      layer: Layer.unwrap(
        Effect.map(Layout, (layout) => Layer.succeed(Server.HttpServerLayer, httpServer(layout.socket))),
      ),
      deps: [PlatformNode.layout],
    }),
  ),
  Ui.uiServerLayer.replace(
    Layer.succeed(
      Ui.UiServerLayer,
      BunHttpServer.layerServer({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        gracefulShutdownTimeout: Duration.zero,
      }),
    ),
  ),
  Identity.hostFactsNode.replace(
    Layer.succeed(Identity.HostFacts, { name: os.hostname(), id: hostId, pid: process.pid }),
  ),
  Load.hostSampleNode.replace(
    LayerNode.make({
      service: Load.HostSample,
      layer: hostSample,
      deps: [PlatformNode.fileSystem, PlatformNode.childProcessSpawner],
    }),
  ),
]

export const app = (info: App.Interface) => App.node.replace(Layer.succeed(App.Service, info))

export const updateCheck = (
  construct: Effect.Effect<UpdateCheck.Interface, never, Scope.Scope | HttpClient.HttpClient | FileSystem.FileSystem>,
) =>
  UpdateCheck.node.replace(
    LayerNode.make({
      service: UpdateCheck.Service,
      layer: Layer.effect(UpdateCheck.Service, construct),
      deps: [PlatformNode.httpClient, PlatformNode.fileSystem],
    }),
  )

const onSignals: Host["onSignals"] = (onSignal) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const hangup = () => process.kill(process.pid, "SIGTERM")
      const interactive = process.stdin.isTTY || process.stdout.isTTY
      process.on("SIGTERM", onSignal)
      process.on("SIGINT", onSignal)

      if (interactive) process.on("SIGHUP", hangup)

      return () => {
        process.off("SIGTERM", onSignal)
        process.off("SIGINT", onSignal)
        process.off("SIGHUP", hangup)
      }
    }),
    (off) => Effect.sync(off),
  ).pipe(Effect.asVoid)

export const daemon: Host = {
  lock,
  checkDatabase,
  trimLog: trimDaemonLog,
  onSignals,
  exit: (code) => Effect.sync(() => process.exit(code)),
}

export const selfCommand: ReadonlyArray<string> =
  process.argv[1] === undefined || process.argv[1].startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, process.argv[1]]

export { ConnectFailed, servePipe, type PipeStdio } from "./pipe-server.ts"

export const exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => {
  const { VIBEST_EXECUTION: _, ...inherited } = process.env
  process.execve!(Bun.which(file) ?? file, [file, ...args], { ...inherited, ...env })
}
