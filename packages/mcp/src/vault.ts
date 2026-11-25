import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"

import { VaultError } from "./errors.ts"

export * as McpVault from "./vault.ts"

const VAULT_FILE = "mcp-credentials.enc"
const VAULT_KEY_FILE = "mcp-vault.key"
const VAULT_KEY_ENV = "VIBEST_MCP_VAULT_KEY"
const ENVELOPE_VERSION = 1
const AAD_PREFIX = "vibest.mcp.vault.v1"

export const StoredTokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  tokenType: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
})

export type StoredTokens = typeof StoredTokens.Type

export const StoredClientInfo = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  clientIdIssuedAt: Schema.optional(Schema.Number),
  clientSecretExpiresAt: Schema.optional(Schema.Number),
  redirectUris: Schema.optional(Schema.Array(Schema.String)),
  issuer: Schema.optional(Schema.String),
})

export type StoredClientInfo = typeof StoredClientInfo.Type

export const StoredDiscovery = Schema.Struct({
  authorizationServer: Schema.String,
  resource: Schema.String,
})

export type StoredDiscovery = typeof StoredDiscovery.Type

export const CredentialEntry = Schema.Struct({
  id: Schema.String,
  serverUrl: Schema.String,
  tokens: Schema.optional(StoredTokens),
  clientInfo: Schema.optional(StoredClientInfo),
  discovery: Schema.optional(StoredDiscovery),
  updatedAt: Schema.Number,
})

export type CredentialEntry = typeof CredentialEntry.Type

const EncryptedRecord = Schema.Struct({
  version: Schema.Literal(ENVELOPE_VERSION),
  algorithm: Schema.Literal("aes-256-gcm"),
  iv: Schema.String,
  ciphertext: Schema.String,
  tag: Schema.String,
})

type EncryptedRecord = typeof EncryptedRecord.Type

const VaultStoreSchema = Schema.Struct({
  version: Schema.Literal(ENVELOPE_VERSION),
  entries: Schema.Record(Schema.String, EncryptedRecord),
})

const decodeVaultStore = Schema.decodeUnknownOption(VaultStoreSchema)
const decodeCredentialEntry = Schema.decodeUnknownOption(CredentialEntry)

export const canonicalServerUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl)
  parsed.hash = ""

  return parsed.toString()
}

const entryKey = (server: string, serverUrl: string): string =>
  crypto
    .createHash("sha256")
    .update(`${server}\0${canonicalServerUrl(serverUrl)}`, "utf8")
    .digest("hex")

const aadFor = (serverUrl: string): Buffer => Buffer.from(`${AAD_PREFIX}\0${canonicalServerUrl(serverUrl)}`, "utf8")

const ensurePrivateFile = (filePath: string): boolean => {
  try {
    const stat = fs.lstatSync(filePath)

    if (!stat.isFile() || stat.isSymbolicLink()) return false

    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return false

    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true

    return false
  }
}

const atomicWritePrivate = (filePath: string, content: string): void => {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`)
  let fd: number | undefined

  try {
    fd = fs.openSync(tmpPath, "wx", 0o600)
    fs.writeFileSync(fd, content, "utf8")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        fd = undefined
      }
    }

    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      fd = undefined
    }

    throw error
  }
}

const resolveVaultKey = (vibestHome: string, envKey?: string): Effect.Effect<Buffer, VaultError> =>
  Effect.try({
    try: () => {
      const fromEnv = envKey ?? process.env[VAULT_KEY_ENV]

      if (fromEnv !== undefined && fromEnv.trim().length > 0) {
        const decoded = Buffer.from(fromEnv.trim(), "base64")

        if (decoded.length !== 32) {
          throw new Error(`${VAULT_KEY_ENV} must decode to exactly 32 bytes`)
        }

        return decoded
      }

      const keyPath = path.join(vibestHome, VAULT_KEY_FILE)

      if (!ensurePrivateFile(keyPath)) {
        throw new Error(`Vault key at ${keyPath} is not a private regular file (0o600 required)`)
      }

      if (fs.existsSync(keyPath)) {
        const existing = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64")

        if (existing.length !== 32) {
          throw new Error(`Vault key at ${keyPath} is corrupted`)
        }

        return existing
      }

      const generated = crypto.randomBytes(32)
      atomicWritePrivate(keyPath, generated.toString("base64"))

      return generated
    },
    catch: (error) =>
      new VaultError({
        operation: "unlock",
        message: error instanceof Error ? error.message : String(error),
      }),
  })

const encryptEntry = (key: Buffer, serverUrl: string, entry: CredentialEntry): EncryptedRecord => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(aadFor(serverUrl))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()])

  return {
    version: ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  }
}

const decryptEntry = (key: Buffer, serverUrl: string, record: EncryptedRecord): CredentialEntry => {
  const iv = Buffer.from(record.iv, "base64")
  const ciphertext = Buffer.from(record.ciphertext, "base64")
  const tag = Buffer.from(record.tag, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAAD(aadFor(serverUrl))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  const decoded = decodeCredentialEntry(JSON.parse(plaintext))

  if (Option.isNone(decoded)) {
    throw new Error("Decrypted vault credential entry has invalid schema")
  }

  return decoded.value
}

export interface RefreshOptions<E> {
  readonly presentedAccess: string | undefined
  readonly shouldRefresh?: (current: CredentialEntry) => boolean
  readonly perform: (current: CredentialEntry) => Effect.Effect<CredentialEntry, E>
  readonly shouldInvalidate: (error: E) => boolean
}

export interface Interface {
  readonly get: (server: string, serverUrl: string) => Effect.Effect<CredentialEntry | undefined, VaultError>
  readonly set: (server: string, serverUrl: string, entry: CredentialEntry) => Effect.Effect<void, VaultError>
  readonly remove: (server: string, serverUrl: string) => Effect.Effect<void, VaultError>
  readonly generation: (server: string, serverUrl: string) => Effect.Effect<number>
  readonly refresh: <E>(
    server: string,
    serverUrl: string,
    options: RefreshOptions<E>,
  ) => Effect.Effect<CredentialEntry | undefined, VaultError | E>
}

export class Service extends Context.Service<Service, Interface>()("@vibest/McpVault") {}

export interface VaultOptions {
  readonly vibestHome: string
  readonly vaultKeyBase64?: string | undefined
}

export const make = (options: VaultOptions): Interface => {
  const vaultPath = path.join(options.vibestHome, VAULT_FILE)
  const cache = new Map<string, CredentialEntry | undefined>()
  const generations = new Map<string, number>()
  const refreshMutexes = new Map<string, Semaphore.Semaphore>()
  const storeLock = Semaphore.makeUnsafe(1)

  const getMutex = (key: string): Semaphore.Semaphore => {
    const existing = refreshMutexes.get(key)

    if (existing) return existing
    const created = Semaphore.makeUnsafe(1)
    refreshMutexes.set(key, created)

    return created
  }

  const readStoreFile = (): Effect.Effect<Record<string, EncryptedRecord>, VaultError> =>
    Effect.try({
      try: () => {
        if (!ensurePrivateFile(vaultPath)) {
          throw new Error(`Vault file at ${vaultPath} is not a private regular file (0o600 required)`)
        }

        if (!fs.existsSync(vaultPath)) return {}
        const decoded = decodeVaultStore(JSON.parse(fs.readFileSync(vaultPath, "utf8")))

        if (Option.isNone(decoded)) {
          throw new Error(`Vault file at ${vaultPath} is corrupted or has unsupported version`)
        }

        return { ...decoded.value.entries }
      },
      catch: (error) =>
        new VaultError({
          operation: "read",
          message: error instanceof Error ? error.message : String(error),
        }),
    })

  const writeStoreFile = (entries: Readonly<Record<string, EncryptedRecord>>): Effect.Effect<void, VaultError> =>
    Effect.try({
      try: () => {
        atomicWritePrivate(vaultPath, JSON.stringify({ version: ENVELOPE_VERSION, entries }, null, 2))
      },
      catch: (error) =>
        new VaultError({
          operation: "write",
          message: error instanceof Error ? error.message : String(error),
        }),
    })

  const get = Effect.fn("McpVault.get")(function* (
    server: string,
    serverUrl: string,
  ): Effect.fn.Return<CredentialEntry | undefined, VaultError> {
    const key = entryKey(server, serverUrl)

    if (cache.has(key)) {
      const cached = cache.get(key)

      return cached ? structuredClone(cached) : undefined
    }

    const encryptionKey = yield* resolveVaultKey(options.vibestHome, options.vaultKeyBase64)
    const store = yield* readStoreFile()
    const record = store[key]

    if (!record) {
      cache.set(key, undefined)

      return undefined
    }

    const entry = yield* Effect.try({
      try: () => decryptEntry(encryptionKey, serverUrl, record),
      catch: (error) =>
        new VaultError({
          operation: "read",
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    cache.set(key, entry)

    return structuredClone(entry)
  })

  const set = Effect.fn("McpVault.set")(function* (
    server: string,
    serverUrl: string,
    entry: CredentialEntry,
  ): Effect.fn.Return<void, VaultError> {
    const key = entryKey(server, serverUrl)

    yield* storeLock.withPermit(
      Effect.gen(function* () {
        const encryptionKey = yield* resolveVaultKey(options.vibestHome, options.vaultKeyBase64)
        const store = yield* readStoreFile()
        const encrypted = encryptEntry(encryptionKey, serverUrl, entry)
        yield* writeStoreFile({ ...store, [key]: encrypted })
        cache.set(key, structuredClone(entry))
      }),
    )
  })

  const remove = Effect.fn("McpVault.remove")(function* (
    server: string,
    serverUrl: string,
  ): Effect.fn.Return<void, VaultError> {
    const key = entryKey(server, serverUrl)
    generations.set(key, (generations.get(key) ?? 0) + 1)
    cache.set(key, undefined)

    yield* storeLock.withPermit(
      Effect.gen(function* () {
        const store = yield* readStoreFile()

        if (!(key in store)) return
        const next = { ...store }
        delete next[key]
        yield* writeStoreFile(next)
      }),
    )
  })

  const generation = (server: string, serverUrl: string): Effect.Effect<number> =>
    Effect.sync(() => generations.get(entryKey(server, serverUrl)) ?? 0)

  const refresh = <E>(
    server: string,
    serverUrl: string,
    refreshOptions: RefreshOptions<E>,
  ): Effect.Effect<CredentialEntry | undefined, VaultError | E> => {
    const key = entryKey(server, serverUrl)
    const mutex = getMutex(key)

    return mutex.withPermit(
      Effect.gen(function* () {
        const startGen = generations.get(key) ?? 0
        const current = yield* get(server, serverUrl)

        if (!current) return undefined

        if (
          refreshOptions.presentedAccess !== undefined &&
          current.tokens?.accessToken !== refreshOptions.presentedAccess
        ) {
          return current
        }

        if (refreshOptions.shouldRefresh && !refreshOptions.shouldRefresh(current)) {
          return current
        }

        const refreshed = yield* refreshOptions.perform(current).pipe(
          Effect.tapError((error) =>
            refreshOptions.shouldInvalidate(error)
              ? Effect.gen(function* () {
                  if ((generations.get(key) ?? 0) === startGen) {
                    yield* remove(server, serverUrl).pipe(Effect.ignore)
                  }
                })
              : Effect.void,
          ),
        )

        if ((generations.get(key) ?? 0) !== startGen) {
          return undefined
        }

        yield* set(server, serverUrl, refreshed)

        return refreshed
      }),
    )
  }

  return { get, set, remove, generation, refresh }
}

export const layer = (options: VaultOptions) => Layer.succeed(Service, make(options))
