import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs"
import fsPromises from "node:fs/promises"

import { BunHttpServer, BunRuntime, BunServices, BunSocket, BunSocketServer } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { CallerEnv } from "@vibest/client/client"
import { SocketConnector } from "@vibest/client/socket-connector"
import { inspectSchema, SchemaMismatch, SQL_NAMES } from "@vibest/core/db"
import { CLAUDE_CREDENTIALS, claudeCredentialsFile, type KeychainPlatform, securityArgs } from "@vibest/core/keychain"
import { type Candidate, type PluginLoader } from "@vibest/core/plugins"
import { type Liveness, livenessOf, type ProcessPlatform, validPid } from "@vibest/core/processes"
import { UserPlatform } from "@vibest/core/system-prompt"
import * as VibestPlugin from "@vibest/plugin"
import { harnessChoicePlugin } from "@vibest/plugin-harness-choice"
import { CALLER_ENV as HC_CALLER_ENV } from "@vibest/runtime-herdr-core/caller"
import { plugin as runtimeHcPlugin } from "@vibest/runtime-herdr-core/plugin"
import { CALLER_ENV as HERDR_CALLER_ENV } from "@vibest/runtime-herdr/caller"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { plugin as runtimeHerdrPlugin } from "@vibest/runtime-herdr/plugin"
import type { Host } from "@vibest/server/daemon"
import * as effect from "effect"
import { Effect, Layer, Stdio, Stream } from "effect"
import * as HerdrBun from "effect-herdr-sdk/bun"

import { graph, keyLocalImports, load, watch } from "./plugin-source.ts"
import { inspect } from "./process-facts.ts"

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

export const services = Layer.mergeAll(
  BunServices.layer,
  unrefStdio,
  HerdrBun.layerSocketConnector,
  Layer.succeed(SocketConnector, (endpoint) => BunSocket.makeNet({ path: endpoint })),
  Layer.succeed(CallerEnv, [...HERDR_CALLER_ENV, ...HC_CALLER_ENV]),
  user,
)

const sqliteLayer = (filename: string, readonly: boolean) =>
  SqliteClient.layer({ filename, readonly, disableWAL: true, ...SQL_NAMES })

const PRIVATE_FILE = 0o600

const privateDatabase = (filename: string) =>
  Effect.tryPromise(async () => {
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
            file: filename,
          })
        : e,
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

export const checkDatabase = (filename: string) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(filename).exists()))) return
    yield* inspectFile(filename)
  }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

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

export const liveness = (pid: number): Liveness => livenessOf(() => process.kill(pid, 0))

const terminate = (pid: number) => {
  if (!validPid(pid)) return
  process.kill(pid, "SIGTERM")
}

const processes: ProcessPlatform = { inspect, liveness, terminate, pid: process.pid, uid: process.getuid?.() }

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

const keychain: KeychainPlatform = {
  password: (service) =>
    process.platform === "darwin"
      ? securityPassword(service)
      : service === CLAUDE_CREDENTIALS && process.env.HOME
        ? credentialFile(claudeCredentialsFile(process.env.HOME))
        : Effect.succeed(undefined),
}

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const LOCK_EX_NB = 2 | 4

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

const builtinPlugins: ReadonlyArray<Candidate> = [
  { source: "builtin:harness-choice", revision: "harness-choice", options: {}, plugin: harnessChoicePlugin },
  { source: "builtin:runtime-herdr", revision: "runtime-herdr", options: {}, plugin: runtimeHerdrPlugin },
  { source: "builtin:runtime-herdr-core", revision: "runtime-herdr-core", options: {}, plugin: runtimeHcPlugin },
  {
    source: "builtin:runtime-choice",
    revision: "runtime-choice",
    options: {},
    plugin: choicePlugin(),
  },
]

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

export const selfCommand: ReadonlyArray<string> =
  process.argv[1] === undefined || process.argv[1].startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, process.argv[1]]

export const exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => {
  process.execve!(Bun.which(file) ?? file, [file, ...args], { ...process.env, ...env })
}
