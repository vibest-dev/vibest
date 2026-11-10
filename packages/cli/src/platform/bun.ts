import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"

import { BunHttpServer, BunRuntime, BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { pre } from "@vibest/builtins"
import { stdioSocket } from "@vibest/client/pipe"
import { SocketConnector } from "@vibest/client/socket-connector"
import { DatabaseOpenFailed, inspectSchema, SchemaMismatch, SQL_NAMES } from "@vibest/core/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { HostFacts, MACHINE_ID_FILES, readHostId } from "@vibest/core/identity"
import { importCheck } from "@vibest/core/import/import"
import { checkReplay } from "@vibest/core/journal"
import { MachineTransport } from "@vibest/core/machines"
import { Layout } from "@vibest/core/paths"
import { messageOf } from "@vibest/core/plugin-sources"
import { Builtins, builtinsNode, PluginLoader } from "@vibest/core/plugins"
import { type Liveness, livenessOf, ProcessPlatform, validPid } from "@vibest/core/processes"
import { HostEnv } from "@vibest/core/runtimes"
import { UserPlatform } from "@vibest/core/system-prompt"
import * as VibestPlugin from "@vibest/plugin"
import { type Host, LockFailed } from "@vibest/server/daemon"
import * as Http from "@vibest/server/http"
import * as Server from "@vibest/server/server"
import * as effect from "effect"
import { Effect, Layer, Stdio, Stream } from "effect"
import * as HerdrBun from "effect-herdr-sdk/bun"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"

import { graph, keyLocalImports, load, watch } from "./plugin-source.ts"

const unrefStdio = Layer.effect(
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

const user = Layer.succeed(UserPlatform, {
  uid: process.getuid?.(),
  lstat: async (file) => {
    const st = await fsPromises.lstat(file)
    return { symlink: st.isSymbolicLink(), directory: st.isDirectory(), uid: st.uid, mode: st.mode }
  },
})

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  unrefStdio,
  HerdrBun.layerSocketConnector,
  Layer.succeed(SocketConnector, (endpoint) => BunSocket.makeNet({ path: endpoint })),
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
          if ((error as { code?: string }).code !== "ENOENT") throw error
        }
      }
    },
    catch: (e) => new DatabaseOpenFailed({ file: filename, message: messageOf(e) }),
  })

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
            ...(e.older === undefined ? {} : { older: e.older }),
            ...(e.catalog === undefined ? {} : { catalog: e.catalog }),
            file: filename,
          })
        : new DatabaseOpenFailed({ file: filename, message: e.message }),
    ),
  )

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

const readOnly = (filename: string) =>
  Layer.build(sqliteLayer(filename, true)).pipe(
    Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
    Effect.mapError((e) => new DatabaseOpenFailed({ file: filename, message: e.message })),
  )

export const checkDatabase: Host["checkDatabase"] = (filename) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(filename).exists()))) return
    if ((yield* inspectFile(filename)) !== "ready") return
    yield* checkReplay(yield* readOnly(filename)).pipe(
      Effect.provide(sqliteLayer(":memory:", false)),
      Effect.catchTag("SqlError", (e) => new DatabaseOpenFailed({ file: filename, message: e.message })),
    )
  }).pipe(Effect.scoped)

const checkLedgerImport: Host["checkLedgerImport"] = (filename) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(filename).exists())))
      return yield* new DatabaseOpenFailed({ file: filename, message: "there is no database file" })
    yield* inspectFile(filename)
    const source = yield* readOnly(filename)
    return yield* importCheck(source).pipe(
      Effect.provide(sqliteLayer(":memory:", false)),
      Effect.catchTag("SqlError", (e) => new DatabaseOpenFailed({ file: ":memory:", message: e.message })),
    )
  }).pipe(Effect.scoped)

export const runMain = BunRuntime.runMain

let mapped = false

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

const processes: ProcessPlatform["Service"] = { liveness, terminate, pid: process.pid, uid: process.getuid?.() }

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const LOCK_EX_NB = 2 | 4

const lockFailed = (file: string) => (e: unknown) => new LockFailed({ file, message: messageOf(e) })

export const lock: Host["lock"] = (file) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600)
        if (libc.symbols.flock(fd, LOCK_EX_NB) === 0) return fd
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

const transport: MachineTransport["Service"] = (argv) =>
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

export const socketServer = (path: string) => BunSocketServer.layer({ path })

const platformNode = LayerNode.make({ name: "vibest/Platform", layer: platform, deps: [] })

export const replacements: LayerNode.Replacements = [
  PlatformNode.fileSystem.replace(platformNode),
  PlatformNode.path.replace(platformNode),
  PlatformNode.crypto.replace(platformNode),
  PlatformNode.childProcessSpawner.replace(platformNode),
  PlatformNode.sqlClient.replace(
    LayerNode.make({
      name: "vibest/Sqlite",
      layer: Layer.unwrap(Effect.map(Layout, (layout) => sqlite(layout.database))),
      deps: [PlatformNode.layout],
    }),
  ),
  MachineTransport.node.replace(Layer.succeed(MachineTransport, transport)),
  PluginLoader.node.replace(Layer.succeed(PluginLoader, plugins)),
  builtinsNode.replace(Layer.succeed(Builtins, pre)),
  HostEnv.node.replace(Layer.succeed(HostEnv, { drop: dropEnv })),
  ProcessPlatform.node.replace(Layer.succeed(ProcessPlatform, processes)),
  Server.socketServer.replace(
    LayerNode.make({
      name: "vibest/SocketServer",
      layer: Layer.unwrap(Effect.map(Layout, (layout) => socketServer(layout.socket))),
      deps: [PlatformNode.layout],
    }),
  ),
  Http.httpServer.replace(
    LayerNode.make({
      name: "vibest/HttpServer/unix",
      layer: Layer.unwrap(Effect.map(Layout, (layout) => BunHttpServer.layerServer({ unix: layout.httpSocket }))),
      deps: [PlatformNode.layout],
    }),
  ),
  HostFacts.node.replace(Layer.succeed(HostFacts, { name: os.hostname(), id: hostId, pid: process.pid })),
]

export const daemon: Host = { lock, checkDatabase, checkLedgerImport }

export const selfCommand: ReadonlyArray<string> =
  process.argv[1] === undefined || process.argv[1].startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, process.argv[1]]

export const exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => {
  process.execve!(Bun.which(file) ?? file, [file, ...args], { ...process.env, ...env })
}
