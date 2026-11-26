import crypto from "node:crypto"

import { PlatformNode } from "@vibest/core/effect/platform"
import { PrivateFile } from "@vibest/core/effect/private-file"
import { Layout } from "@vibest/schema/layout"
import { Mcp } from "@vibest/schema/mcp"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"

import { McpSecrets } from "./secrets.ts"

export * as McpMetadataCache from "./metadata-cache.ts"

const CACHE_VERSION = 1

export const CachedServerEntry = Schema.Struct({
  fingerprint: Schema.String,
  cachedAt: Schema.Number,
  ttlMs: Schema.optional(Schema.Number),
  cacheScope: Schema.optional(Schema.Literals(["public", "shared", "private"])),
  title: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  tools: Schema.Array(Mcp.ToolInfo),
})

export type CachedServerEntry = typeof CachedServerEntry.Type

const DiskCacheSchema = Schema.Struct({
  version: Schema.Literal(CACHE_VERSION),
  servers: Schema.Record(Schema.String, CachedServerEntry),
})

const decodeDiskCache = Schema.decodeUnknownOption(DiskCacheSchema)

export interface FingerprintInput {
  readonly config: Mcp.ServerConfig
  readonly resolvedCwd?: string | undefined
  readonly credentialId?: string | undefined
}

export const computeFingerprint = (input: FingerprintInput): string => {
  const config = input.config

  const payload =
    config.type === "local"
      ? {
          type: "local",
          command: config.command,
          resolvedCwd: input.resolvedCwd ?? null,
          envFingerprint: McpSecrets.fingerprintSecret(config.environment),
          includeTools: config.includeTools ?? null,
          excludeTools: config.excludeTools ?? null,
        }
      : {
          type: "remote",
          url: config.url,
          headerFingerprint: McpSecrets.fingerprintSecret(config.headers),
          bearerFingerprint: McpSecrets.fingerprintSecret(config.bearerToken),
          credentialId: input.credentialId ?? null,
          includeTools: config.includeTools ?? null,
          excludeTools: config.excludeTools ?? null,
        }

  return crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")
}

export const isPersistable = (
  config: Mcp.ServerConfig,
  options?: { readonly cacheScope?: "public" | "shared" | "private" | undefined; readonly ttlMs?: number | undefined },
): boolean => {
  if (options?.cacheScope === "private") return false

  if (options?.ttlMs === 0) return false

  if (config.type === "local" && config.cwd === undefined) return false

  return true
}

export interface Interface {
  readonly get: (
    server: string,
    fingerprint: string,
    now?: number,
    maxAgeMs?: number,
  ) => Effect.Effect<CachedServerEntry | undefined>
  readonly set: (server: string, config: Mcp.ServerConfig, entry: CachedServerEntry) => Effect.Effect<void>
  readonly invalidate: (server: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vibest/McpMetadataCache") {}

const isEntryValid = (entry: CachedServerEntry, fingerprint: string, now: number, maxAgeMs: number): boolean => {
  if (entry.fingerprint !== fingerprint) return false

  if (entry.ttlMs !== undefined) {
    if (entry.ttlMs === 0) return false
    const limit = maxAgeMs > 0 ? Math.min(maxAgeMs, entry.ttlMs) : entry.ttlMs

    return now - entry.cachedAt < limit
  }

  if (maxAgeMs > 0 && now - entry.cachedAt > maxAgeMs) return false

  return true
}

export const make = Effect.fn("McpMetadataCache.make")(function* (
  vibestHome: string,
): Effect.fn.Return<Interface, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cachePath = path.join(vibestHome, "cache", "mcp-metadata-cache.json")
  const memory = new Map<string, CachedServerEntry>()

  const readDisk = (): Effect.Effect<Record<string, CachedServerEntry>> =>
    fs.readFileString(cachePath).pipe(
      Effect.map((raw) => {
        try {
          const parsed = decodeDiskCache(JSON.parse(raw))

          return Option.isSome(parsed) ? { ...parsed.value.servers } : {}
        } catch {
          return {}
        }
      }),
      Effect.orElseSucceed(() => ({})),
    )

  const writeDisk = (servers: Readonly<Record<string, CachedServerEntry>>): Effect.Effect<void> =>
    PrivateFile.writeAtomic(fs, path, cachePath, JSON.stringify({ version: CACHE_VERSION, servers }, null, 2)).pipe(
      Effect.ignore,
    )

  const removeFromDisk = (server: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const disk = yield* readDisk()

      if (!(server in disk)) return
      const next = { ...disk }
      delete next[server]
      yield* writeDisk(next)
    })

  const get = Effect.fn("McpMetadataCache.get")(function* (
    server: string,
    fingerprint: string,
    now?: number,
    maxAgeMs = 0,
  ): Effect.fn.Return<CachedServerEntry | undefined> {
    const currentNow = now ?? (yield* Clock.currentTimeMillis)
    const inMem = memory.get(server)

    if (inMem !== undefined) {
      if (isEntryValid(inMem, fingerprint, currentNow, maxAgeMs)) return inMem

      if (inMem.cacheScope === "private" || inMem.ttlMs === 0) return undefined
    }

    const disk = (yield* readDisk())[server]

    if (!disk) return undefined

    if (disk.cacheScope === "private" || disk.ttlMs === 0) return undefined

    if (!isEntryValid(disk, fingerprint, currentNow, maxAgeMs)) return undefined
    memory.set(server, disk)

    return disk
  })

  const set = Effect.fn("McpMetadataCache.set")(function* (
    server: string,
    config: Mcp.ServerConfig,
    entry: CachedServerEntry,
  ): Effect.fn.Return<void> {
    memory.set(server, entry)

    if (!isPersistable(config, { cacheScope: entry.cacheScope, ttlMs: entry.ttlMs })) {
      yield* removeFromDisk(server)

      return
    }

    const disk = yield* readDisk()
    yield* writeDisk({ ...disk, [server]: entry })
  })

  const invalidate = Effect.fn("McpMetadataCache.invalidate")(function* (server: string): Effect.fn.Return<void> {
    memory.delete(server)
    yield* removeFromDisk(server)
  })

  return Service.of({ get, set, invalidate })
})

export const layer = (vibestHome?: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const home = vibestHome ?? (yield* Layout).home

      return yield* make(home)
    }),
  )

export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [PlatformNode.layout, PlatformNode.fileSystem, PlatformNode.path],
})
