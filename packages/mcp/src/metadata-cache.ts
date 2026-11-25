import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { Mcp } from "@vibest/schema/mcp"
import { Option, Schema } from "effect"

import { McpSecrets } from "./secrets.ts"

export * as McpMetadataCache from "./metadata-cache.ts"

const CACHE_VERSION = 1

export const CachedServerEntry = Schema.Struct({
  fingerprint: Schema.String,
  cachedAt: Schema.Number,
  ttlMs: Schema.optional(Schema.Number),
  cacheScope: Schema.optional(Schema.Literals(["shared", "private"])),
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
  options?: { readonly cacheScope?: "shared" | "private" | undefined; readonly ttlMs?: number | undefined },
): boolean => {
  if (options?.cacheScope === "private") return false

  if (options?.ttlMs === 0) return false

  if (config.type === "local" && config.cwd === undefined) return false

  return true
}

export interface MetadataCacheStore {
  readonly get: (server: string, fingerprint: string, now?: number, maxAgeMs?: number) => CachedServerEntry | undefined
  readonly set: (server: string, config: Mcp.ServerConfig, entry: CachedServerEntry) => void
  readonly invalidate: (server: string) => void
}

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

export const make = (vibestHome: string): MetadataCacheStore => {
  const cachePath = path.join(vibestHome, "cache", "mcp-metadata-cache.json")
  const memory = new Map<string, CachedServerEntry>()

  const readDisk = (): Record<string, CachedServerEntry> => {
    if (!fs.existsSync(cachePath)) return {}

    try {
      const parsed = decodeDiskCache(JSON.parse(fs.readFileSync(cachePath, "utf8")))

      return Option.isSome(parsed) ? { ...parsed.value.servers } : {}
    } catch {
      return {}
    }
  }

  const writeDisk = (servers: Readonly<Record<string, CachedServerEntry>>): void => {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, servers }, null, 2), "utf8")
      fs.renameSync(tmp, cachePath)
    } catch {
      return
    }
  }

  const get = (server: string, fingerprint: string, now = Date.now(), maxAgeMs = 0): CachedServerEntry | undefined => {
    const inMem = memory.get(server)

    if (inMem && isEntryValid(inMem, fingerprint, now, maxAgeMs)) return inMem
    const disk = readDisk()[server]

    if (!disk) return undefined

    if (disk.cacheScope === "private" || disk.ttlMs === 0) return undefined

    if (!isEntryValid(disk, fingerprint, now, maxAgeMs)) return undefined
    memory.set(server, disk)

    return disk
  }

  const set = (server: string, config: Mcp.ServerConfig, entry: CachedServerEntry): void => {
    memory.set(server, entry)

    if (!isPersistable(config, { cacheScope: entry.cacheScope, ttlMs: entry.ttlMs })) return
    const disk = readDisk()
    writeDisk({ ...disk, [server]: entry })
  }

  const invalidate = (server: string): void => {
    memory.delete(server)
    const disk = readDisk()

    if (!(server in disk)) return
    const next = { ...disk }
    delete next[server]
    writeDisk(next)
  }

  return { get, set, invalidate }
}
