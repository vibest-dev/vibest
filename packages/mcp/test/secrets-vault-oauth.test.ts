import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import { BunServices } from "@effect/platform-bun"
import { Bus } from "@vibest/core/bus"
import { Layout } from "@vibest/schema/layout"
import type { Mcp as McpSchema } from "@vibest/schema/mcp"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Stream } from "effect"
import { describe, expect, it } from "vitest"

import { OAuthFlowError } from "../src/errors.ts"
import { Mcp } from "../src/index.ts"
import { McpMetadataCache } from "../src/metadata-cache.ts"
import { McpOAuth } from "../src/oauth.ts"
import { McpPool } from "../src/pool.ts"
import { McpSecrets } from "../src/secrets.ts"
import { McpVault } from "../src/vault.ts"

const withTempDirAsync = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-sec-"))

  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const noopBusLayer = Layer.succeed(
  Bus.Service,
  Bus.Service.of({
    subscribe: () => Effect.die("unused"),
    publish: () => Effect.succeed(undefined as never),
    transaction: (effect) => effect,
    afterCommit: () => Effect.undefined,
    log: () => Stream.empty,
    project: () => Effect.undefined,
    rebuild: Effect.void,
  }),
)

const testMcpEnv = (vibestHome: string) => {
  const layoutLayer = Layer.effect(Layout, Layout.make(vibestHome)).pipe(Layer.provide(BunServices.layer))
  const base = Layer.mergeAll(BunServices.layer, layoutLayer, noopBusLayer)

  const deps = Layer.mergeAll(McpPool.layer(), McpVault.layer({ vibestHome }), McpMetadataCache.layer(vibestHome)).pipe(
    Layer.provideMerge(base),
  )

  return deps
}

describe("McpSecrets lazy !command resolver", () => {
  it("never executes !command during fingerprinting, unescapes !!, resolves lazily, and fails closed", async () => {
    await withTempDirAsync(async (dir) => {
      const marker = path.join(dir, "executed.txt")
      const cmd = `!sh -c 'echo ran > "${marker}"; printf "secret-val"'`

      const fp = McpSecrets.fingerprintSecret({ Authorization: cmd })
      expect(fp).toMatch(/^[0-9a-f]{64}$/)
      expect(fs.existsSync(marker)).toBe(false)

      const escaped = await Effect.runPromise(
        McpSecrets.resolveValue("!!literal-bang", "test").pipe(Effect.provide(BunServices.layer)),
      )

      expect(escaped).toBe("!literal-bang")

      const resolved = await Effect.runPromise(
        McpSecrets.resolveValue(cmd, "test").pipe(Effect.provide(BunServices.layer)),
      )

      expect(resolved).toBe("secret-val")
      expect(fs.existsSync(marker)).toBe(true)

      const exit = await Effect.runPromiseExit(
        McpSecrets.resolveValue("!sh -c 'exit 1'", "test.fail").pipe(Effect.provide(BunServices.layer)),
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })
})

describe("McpVault AES-256-GCM AAD, single-flight refresh, and logout generation lock", () => {
  it("encrypts at rest with 0o600, binds canonicalServerUrl as AAD, and supports host import", async () => {
    await withTempDirAsync(async (root) => {
      const vibestHome = path.join(root, "vibest")
      const serverUrl = "https://mcp.example.com/v1#frag"

      await Effect.runPromise(
        Effect.gen(function* () {
          const vault = yield* McpVault.make({ vibestHome })

          yield* vault.set("demo", serverUrl, {
            id: "cred-1",
            serverUrl: McpVault.canonicalServerUrl(serverUrl),
            tokens: { accessToken: "super-secret-token-123", refreshToken: "refresh-abc" },
            updatedAt: Date.now(),
          })
        }).pipe(Effect.provide(BunServices.layer)),
      )

      const encPath = path.join(vibestHome, "mcp-credentials.enc")
      const keyPath = path.join(vibestHome, "mcp-vault.key")
      const rawEnc = fs.readFileSync(encPath, "utf8")
      expect(rawEnc).not.toContain("super-secret-token-123")
      expect(rawEnc).not.toContain("refresh-abc")

      if (process.platform !== "win32") {
        expect(fs.statSync(encPath).mode & 0o077).toBe(0)
        expect(fs.statSync(keyPath).mode & 0o077).toBe(0)
      }

      const loaded = await Effect.runPromise(
        Effect.gen(function* () {
          const freshVault = yield* McpVault.make({ vibestHome })

          return yield* freshVault.get("demo", "https://mcp.example.com/v1")
        }).pipe(Effect.provide(BunServices.layer)),
      )

      expect(loaded?.tokens?.accessToken).toBe("super-secret-token-123")

      const tampered = JSON.parse(rawEnc) as {
        version: number
        entries: Record<string, Record<string, string | number>>
      }

      const originalKey = Object.keys(tampered.entries)[0]!

      const swappedKey = crypto.createHash("sha256").update(`demo\0https://evil.example.com/v1`, "utf8").digest("hex")

      tampered.entries[swappedKey] = tampered.entries[originalKey]!
      fs.writeFileSync(encPath, JSON.stringify(tampered), { mode: 0o600 })

      const swappedExit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const fresh = yield* McpVault.make({ vibestHome })

          return yield* fresh.get("demo", "https://evil.example.com/v1")
        }).pipe(Effect.provide(BunServices.layer)),
      )

      expect(Exit.isFailure(swappedExit)).toBe(true)
    })
  })

  it("serializes concurrent refreshes (single-flight) and discards refresh if logout occurred mid-flight", async () => {
    await withTempDirAsync(async (vibestHome) => {
      const url = "https://api.example.com/mcp"

      await Effect.runPromise(
        Effect.gen(function* () {
          const vault = yield* McpVault.make({ vibestHome })

          yield* vault.set("svc", url, {
            id: "c1",
            serverUrl: url,
            tokens: { accessToken: "tok-v1", refreshToken: "ref-v1" },
            updatedAt: 1,
          })

          let performCount = 0

          const [r1, r2] = yield* Effect.all(
            [
              vault.refresh("svc", url, {
                presentedAccess: "tok-v1",
                perform: (cur) =>
                  Effect.gen(function* () {
                    performCount++
                    yield* Effect.sleep("30 millis")

                    return { ...cur, tokens: { accessToken: "tok-v2", refreshToken: "ref-v2" }, updatedAt: 2 }
                  }),
                shouldInvalidate: () => false,
              }),
              vault.refresh("svc", url, {
                presentedAccess: "tok-v1",
                perform: (cur) =>
                  Effect.sync(() => {
                    performCount++

                    return { ...cur, tokens: { accessToken: "tok-v3", refreshToken: "ref-v3" }, updatedAt: 3 }
                  }),
                shouldInvalidate: () => false,
              }),
            ],
            { concurrency: 2 },
          )

          expect(performCount).toBe(1)
          expect(r1?.tokens?.accessToken).toBe("tok-v2")
          expect(r2?.tokens?.accessToken).toBe("tok-v2")

          const transientExit = yield* Effect.exit(
            vault.refresh("svc", url, {
              presentedAccess: "tok-v2",
              perform: () => Effect.fail(new Error("HTTP 503")),
              shouldInvalidate: () => false,
            }),
          )

          expect(Exit.isFailure(transientExit)).toBe(true)
          expect((yield* vault.get("svc", url))?.tokens?.accessToken).toBe("tok-v2")

          const started = Deferred.makeUnsafe<void>()
          const release = Deferred.makeUnsafe<void>()

          const fiber = yield* Effect.forkChild(
            vault.refresh("svc", url, {
              presentedAccess: "tok-v2",
              perform: (cur) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)

                  return { ...cur, tokens: { accessToken: "tok-stale", refreshToken: "ref-stale" }, updatedAt: 4 }
                }),
              shouldInvalidate: () => false,
            }),
          )

          yield* Deferred.await(started)
          yield* vault.remove("svc", url)
          yield* Deferred.succeed(release, undefined)

          const result = yield* Fiber.join(fiber)
          expect(result).toBeUndefined()
          expect(yield* vault.get("svc", url)).toBeUndefined()
        }).pipe(Effect.provide(BunServices.layer)),
      )
    })
  })
})

describe("McpOAuth PKCE 2-step headless flow, origin-locked headers, and 403 insufficient_scope", () => {
  it("completes 2-step SSH authStart -> authComplete with DCR & PKCE S256 and enforces state/origin/redirect", async () => {
    await withTempDirAsync(async (vibestHome) => {
      let lastTokenBody = ""

      const asServer = http.createServer((req, res) => {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1")
        const base = `http://127.0.0.1:${(asServer.address() as AddressInfo).port}`

        if (reqUrl.pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              issuer: base,
              authorization_endpoint: `${base}/authorize`,
              token_endpoint: `${base}/token`,
              registration_endpoint: `${base}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
            }),
          )

          return
        }

        if (reqUrl.pathname === "/register" && req.method === "POST") {
          res
            .writeHead(201, { "content-type": "application/json" })
            .end(JSON.stringify({ client_id: "dcr-client-1", redirect_uris: ["http://127.0.0.1/cb"] }))

          return
        }

        if (reqUrl.pathname === "/token" && req.method === "POST") {
          const chunks: Array<Buffer> = []
          req.on("data", (chunk: Buffer) => chunks.push(chunk))
          req.on("end", () => {
            lastTokenBody = Buffer.concat(chunks).toString("utf8")
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                access_token: "oauth-access-xyz",
                refresh_token: "oauth-refresh-xyz",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "read write",
              }),
            )
          })

          return
        }

        res.writeHead(401).end("unauthorized")
      })

      await new Promise<void>((resolve) => asServer.listen(0, "127.0.0.1", resolve))
      const port = (asServer.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const vault = yield* McpVault.Service
            const manager = yield* McpOAuth.makeAuthManager({ enableLoopback: false })

            const config: McpSchema.RemoteServerConfig = {
              type: "remote",
              url: `${base}/mcp`,
              oauth: {
                authServerMetadataUrl: `${base}/.well-known/oauth-authorization-server`,
                redirectUri: "http://127.0.0.1/cb",
              },
            }

            const started = yield* manager.authStart("remote-demo", config)
            const authUrl = new URL(started.authorizationUrl)
            expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256")
            expect(authUrl.searchParams.get("state")).toBe(started.state)
            expect(authUrl.searchParams.get("client_id")).toBe("dcr-client-1")

            const badState = yield* Effect.exit(
              manager.authComplete("remote-demo", `http://127.0.0.1/cb?code=abc&state=wrong-state`),
            )

            expect(Exit.isFailure(badState)).toBe(true)

            const completed = yield* manager.authComplete(
              "remote-demo",
              `http://127.0.0.1/cb?code=auth-code-99&state=${started.state}`,
            )

            expect(completed.authenticated).toBe(true)
            expect(completed.scope).toBe("read write")
            expect(lastTokenBody).toContain("code=auth-code-99")
            expect(lastTokenBody).toContain("code_verifier=")

            const stored = yield* vault.get("remote-demo", config.url)
            expect(stored?.tokens?.accessToken).toBe("oauth-access-xyz")
          }).pipe(Effect.provide(testMcpEnv(vibestHome))),
        )
      } finally {
        asServer.close()
      }
    })

    const captured: Array<{
      readonly url: string
      readonly hasCustom: boolean
      readonly redirect: string | undefined
    }> = []

    const scoped = McpOAuth.createScopedFetch({
      serverUrl: "https://resource.example.com/mcp",
      customHeaders: { "X-Api-Key": "secret-key" },
      baseFetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        captured.push({
          url: String(input),
          hasCustom: headers.get("X-Api-Key") === "secret-key",
          redirect: init?.redirect,
        })

        return new Response("ok", { status: 200 })
      },
    })

    await scoped("https://resource.example.com/mcp/tools")
    await scoped("https://auth.other-origin.example.com/token")

    expect(captured[0]).toEqual({
      url: "https://resource.example.com/mcp/tools",
      hasCustom: true,
      redirect: "manual",
    })
    expect(captured[1]).toEqual({
      url: "https://auth.other-origin.example.com/token",
      hasCustom: false,
      redirect: "manual",
    })

    const stepUpRes = new Response("forbidden", {
      status: 403,
      headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin:write"' },
    })

    expect(McpOAuth.extractInsufficientScope(stepUpRes)).toBe("admin:write")
  })

  it("returns typed OAuthFlowError on malformed URLs and resolves !command secrets before HTTP requests", async () => {
    await withTempDirAsync(async (vibestHome) => {
      const badUrlExit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const manager = yield* McpOAuth.makeAuthManager({ enableLoopback: false })

          return yield* manager.authStart("bad", { type: "remote", url: "not-a-valid-url" })
        }).pipe(Effect.provide(testMcpEnv(vibestHome))),
      )

      expect(Exit.isFailure(badUrlExit)).toBe(true)

      if (Exit.isFailure(badUrlExit)) {
        const failure = Cause.findErrorOption(badUrlExit.cause)
        expect(Option.isSome(failure)).toBe(true)

        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(OAuthFlowError)
        }
      }

      const seenHeaders: Array<{ readonly auth: string | undefined; readonly apiKey: string | undefined }> = []

      const mcpServer = http.createServer((req, res) => {
        seenHeaders.push({
          auth: Predicate.isString(req.headers.authorization) ? req.headers.authorization : undefined,
          apiKey: Predicate.isString(req.headers["x-api-key"]) ? req.headers["x-api-key"] : undefined,
        })

        res.writeHead(401).end("unauthorized")
      })

      await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve))
      const port = (mcpServer.address() as AddressInfo).port

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const rt = yield* Mcp.make()

              yield* rt.add("remote-secret", {
                type: "remote",
                url: `http://127.0.0.1:${port}/mcp`,
                bearerToken: "!printf resolved-bearer-123",
                headers: { "X-Api-Key": "!printf resolved-key-456" },
                protocol: "legacy",
              })

              yield* rt.connect("remote-secret")
            }),
          ).pipe(Effect.provide(testMcpEnv(vibestHome))),
        )

        expect(seenHeaders.length).toBeGreaterThan(0)
        expect(seenHeaders[0]?.auth).toBe("Bearer resolved-bearer-123")
        expect(seenHeaders[0]?.apiKey).toBe("resolved-key-456")
      } finally {
        mcpServer.close()
      }
    })
  })
})
