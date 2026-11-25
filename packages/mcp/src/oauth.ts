import crypto from "node:crypto"
import http from "node:http"

import {
  auth,
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  resourceUrlFromServerUrl,
  UnauthorizedError,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/core"
import { Mcp } from "@vibest/schema/mcp"
import { Clock, Duration, Effect, Option, Predicate, Schema } from "effect"

import { OAuthFlowError } from "./errors.ts"
import { McpVault } from "./vault.ts"

export * as McpOAuth from "./oauth.ts"

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
})

const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponseSchema)
const decodeServerName = Schema.decodeUnknownSync(Mcp.ServerName)

const REFRESH_AHEAD_MS = Duration.toMillis(Duration.seconds(30))
const PENDING_FLOW_TTL_MS = Duration.toMillis(Duration.minutes(5))

const PERMANENT_REJECTIONS = new Set<string>([
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.UnauthorizedClient,
])

class RefreshRejected extends Schema.TaggedError<RefreshRejected>()("McpOAuth.RefreshRejected", {
  message: Schema.String,
}) {}

class IssuerChanged extends Schema.TaggedError<IssuerChanged>()("McpOAuth.IssuerChanged", {
  message: Schema.String,
}) {}

export const selectResource = (serverUrl: string, resource: string | undefined): URL => {
  const identity = new URL(serverUrl)
  identity.hash = ""

  if (!resource) return identity

  if (!checkResourceAllowed({ requestedResource: identity, configuredResource: resource })) {
    throw new Error(`Protected resource ${resource} does not cover ${identity}`)
  }

  const canonical = new URL(resource)

  if (canonical.origin === identity.origin && canonical.pathname === identity.pathname) return identity

  return canonical
}

export const extractInsufficientScope = (response: Response): string | undefined => {
  if (response.status !== 403) return undefined
  const header = response.headers.get("www-authenticate")

  if (!header) return undefined

  if (!/error\s*=\s*"?insufficient_scope"?/i.test(header)) return undefined
  const scopeMatch = /scope\s*=\s*"([^"]+)"/i.exec(header)

  return scopeMatch?.[1] ?? ""
}

export const createScopedFetch = (options: {
  readonly serverUrl: string
  readonly customHeaders?: Readonly<Record<string, string>> | undefined
  readonly baseFetch?: FetchLike | undefined
}): FetchLike => {
  const base = options.baseFetch ?? globalThis.fetch
  const allowedOrigin = new URL(options.serverUrl).origin

  return (input, init) => {
    const targetUrl = input instanceof URL ? input : new URL(input)

    const headers = new Headers(init?.headers)

    if (options.customHeaders && targetUrl.origin === allowedOrigin) {
      for (const [key, value] of Object.entries(options.customHeaders)) {
        if (!headers.has(key)) headers.set(key, value)
      }
    }

    return base(input, { ...init, headers, redirect: "manual" })
  }
}

const configuredDiscovery = async (
  config: Mcp.RemoteServerConfig,
  fetchFn: FetchLike,
): Promise<OAuthDiscoveryState | undefined> => {
  const url = config.oauth ? config.oauth.authServerMetadataUrl : undefined

  if (!url) return undefined
  const response = await fetchFn(url, { headers: { accept: "application/json" } })

  if (!response.ok) throw new Error(`HTTP ${response.status} loading OAuth authorization server metadata`)
  const body = await response.json()
  const metadata = OAuthMetadataSchema.safeParse(body).data ?? OpenIdProviderDiscoveryMetadataSchema.parse(body)

  return {
    authorizationServerUrl: metadata.issuer,
    authorizationServerMetadata: metadata,
    resourceMetadata: { resource: resourceUrlFromServerUrl(config.url).toString() },
  }
}

const toVaultEntry = (input: {
  readonly serverUrl: string
  readonly tokens: StoredOAuthTokens
  readonly clientInfo?: StoredOAuthClientInformation | undefined
  readonly discovery?: McpVault.StoredDiscovery | undefined
  readonly issuer?: string | undefined
  readonly now: number
}): McpVault.CredentialEntry => ({
  id: crypto.randomUUID(),
  serverUrl: McpVault.canonicalServerUrl(input.serverUrl),
  tokens: {
    accessToken: input.tokens.access_token,
    ...(input.tokens.refresh_token !== undefined && { refreshToken: input.tokens.refresh_token }),
    ...(input.tokens.token_type !== undefined && { tokenType: input.tokens.token_type }),
    ...(input.tokens.expires_in !== undefined && { expiresAt: input.now + input.tokens.expires_in * 1000 }),
    ...(input.tokens.scope !== undefined && { scope: input.tokens.scope }),
    ...(input.issuer !== undefined && { issuer: input.issuer }),
  },
  ...(input.clientInfo !== undefined && {
    clientInfo: {
      clientId: input.clientInfo.client_id,
      ...(input.clientInfo.client_secret !== undefined && { clientSecret: input.clientInfo.client_secret }),
      ...(input.clientInfo.client_id_issued_at !== undefined && {
        clientIdIssuedAt: input.clientInfo.client_id_issued_at,
      }),
      ...(input.clientInfo.client_secret_expires_at !== undefined && {
        clientSecretExpiresAt: input.clientInfo.client_secret_expires_at,
      }),
      ...(input.issuer !== undefined && { issuer: input.issuer }),
    },
  }),
  ...(input.discovery !== undefined && { discovery: input.discovery }),
  updatedAt: input.now,
})

const exchangeRefresh = (input: {
  readonly config: Mcp.RemoteServerConfig
  readonly fetchFn: FetchLike
  readonly current: McpVault.CredentialEntry
  readonly resourceMetadataUrl: URL | undefined
  readonly now: number
}): Effect.Effect<McpVault.CredentialEntry, RefreshRejected | IssuerChanged | Error> =>
  Effect.tryPromise({
    try: async (signal) => {
      const fetchFn: FetchLike = async (url, init) => {
        const response = await input.fetchFn(url, { ...init, signal })

        if (init?.method === "POST" && (response.status === 408 || response.status === 429 || response.status >= 500)) {
          throw new Error(`HTTP ${response.status}`)
        }

        return response
      }

      const oauth = input.config.oauth || undefined

      const client: StoredOAuthClientInformation | undefined = oauth?.clientId
        ? {
            client_id: oauth.clientId,
            ...(oauth.clientSecret !== undefined && { client_secret: oauth.clientSecret }),
          }
        : input.current.clientInfo
          ? {
              client_id: input.current.clientInfo.clientId,
              ...(input.current.clientInfo.clientSecret !== undefined && {
                client_secret: input.current.clientInfo.clientSecret,
              }),
            }
          : undefined

      if (!client) throw new RefreshRejected({ message: "no OAuth client information" })
      const refreshToken = input.current.tokens?.refreshToken

      if (!refreshToken) throw new RefreshRejected({ message: "no refresh token available" })
      const saved = input.current.discovery
      const configured = await configuredDiscovery(input.config, fetchFn)

      const server =
        configured ??
        (saved
          ? {
              authorizationServerUrl: saved.authorizationServer,
              authorizationServerMetadata: await discoverAuthorizationServerMetadata(saved.authorizationServer, {
                fetchFn,
              }),
              resourceMetadata: undefined,
            }
          : await discoverOAuthServerInfo(input.config.url, {
              ...(input.resourceMetadataUrl !== undefined && { resourceMetadataUrl: input.resourceMetadataUrl }),
              fetchFn,
            }))

      const foundIssuer = server.authorizationServerMetadata?.issuer ?? server.authorizationServerUrl
      const savedIssuer = input.current.tokens?.issuer

      if (
        !oauth?.skipIssuerValidation &&
        savedIssuer !== undefined &&
        foundIssuer.replace(/\/$/, "") !== savedIssuer.replace(/\/$/, "")
      ) {
        throw new IssuerChanged({ message: `issued by ${savedIssuer}, but discovery names ${foundIssuer}` })
      }

      const resource = saved?.resource ?? selectResource(input.config.url, server.resourceMetadata?.resource).toString()

      const tokens = await refreshAuthorization(server.authorizationServerUrl, {
        ...(server.authorizationServerMetadata !== undefined && { metadata: server.authorizationServerMetadata }),
        clientInformation: client,
        refreshToken,
        resource,
        fetchFn,
      })

      return toVaultEntry({
        serverUrl: input.config.url,
        tokens: { refresh_token: refreshToken, ...tokens },
        clientInfo: client,
        issuer: foundIssuer,
        discovery: configured ? undefined : { authorizationServer: server.authorizationServerUrl, resource },
        now: input.now,
      })
    },
    catch: (error) => {
      if (error instanceof RefreshRejected || error instanceof IssuerChanged) return error

      if (error instanceof OAuthError && PERMANENT_REJECTIONS.has(error.code)) {
        return new RefreshRejected({ message: error.message })
      }

      return error instanceof Error ? error : new Error(String(error))
    },
  })

interface PresentedTokenState {
  presented: string | undefined
}

export const connectProvider = (input: {
  readonly server: string
  readonly config: Mcp.RemoteServerConfig
  readonly vault: McpVault.Interface
  readonly fetchFn: FetchLike
}): AuthProvider => {
  if (input.config.bearerToken !== undefined) {
    const token = input.config.bearerToken

    return {
      token: async () => token,
    }
  }

  if (input.config.oauth === false) {
    return { token: async () => undefined }
  }

  const state: PresentedTokenState = { presented: undefined }
  const refused = () => new UnauthorizedError(`MCP server "${input.config.url}" requires user authorization`)

  return {
    token: async () => {
      const entry = await Effect.runPromise(
        input.vault.get(input.server, input.config.url).pipe(Effect.orElseSucceed(() => undefined)),
      )

      if (!entry?.tokens) {
        state.presented = undefined

        return undefined
      }

      const now = Date.now()

      const expiringSoon =
        entry.tokens.expiresAt !== undefined &&
        entry.tokens.expiresAt > 0 &&
        now + REFRESH_AHEAD_MS >= entry.tokens.expiresAt

      if (expiringSoon && entry.tokens.refreshToken) {
        const refreshed = await Effect.runPromise(
          input.vault
            .refresh(input.server, input.config.url, {
              presentedAccess: entry.tokens.accessToken,
              shouldRefresh: (cur) =>
                cur.tokens?.expiresAt !== undefined &&
                cur.tokens.expiresAt > 0 &&
                now + REFRESH_AHEAD_MS >= cur.tokens.expiresAt,
              perform: (cur) =>
                exchangeRefresh({
                  config: input.config,
                  fetchFn: input.fetchFn,
                  current: cur,
                  resourceMetadataUrl: undefined,
                  now,
                }),
              shouldInvalidate: (error) => error instanceof RefreshRejected,
            })
            .pipe(Effect.orElseSucceed(() => entry)),
        )

        state.presented = refreshed?.tokens?.accessToken

        return state.presented
      }

      state.presented = entry.tokens.accessToken

      return state.presented
    },
    onUnauthorized: async (context) => {
      const rejected = state.presented
      const wwwAuth = extractWWWAuthenticateParams(context.response)
      const now = Date.now()

      const refreshed = await Effect.runPromise(
        input.vault
          .refresh(input.server, input.config.url, {
            presentedAccess: rejected,
            perform: (cur) =>
              exchangeRefresh({
                config: input.config,
                fetchFn: input.fetchFn,
                current: cur,
                resourceMetadataUrl: wwwAuth.resourceMetadataUrl,
                now,
              }),
            shouldInvalidate: (error) => error instanceof RefreshRejected,
          })
          .pipe(
            Effect.catch((error) => {
              if (error instanceof RefreshRejected || error instanceof IssuerChanged) {
                return Effect.fail(refused())
              }

              return Effect.fail(
                new OAuthError(
                  OAuthErrorCode.TemporarilyUnavailable,
                  `Could not refresh OAuth token: ${error instanceof Error ? error.message : String(error)}`,
                ),
              )
            }),
          ),
      )

      if (!refreshed?.tokens?.accessToken) throw refused()
    },
  }
}

export const clientCredentialsGrant = Effect.fn("McpOAuth.clientCredentialsGrant")(function* (input: {
  readonly server: string
  readonly config: Mcp.RemoteServerConfig
  readonly vault: McpVault.Interface
  readonly fetchFn: FetchLike
}): Effect.fn.Return<McpVault.CredentialEntry, OAuthFlowError> {
  const oauth = input.config.oauth || undefined

  if (!oauth?.clientId || !oauth.clientSecret) {
    return yield* new OAuthFlowError({
      server: input.server,
      message: "client_credentials grant requires oauth.clientId and oauth.clientSecret",
    })
  }

  const now = yield* Clock.currentTimeMillis

  const entry = yield* Effect.tryPromise({
    try: async () => {
      const discovery =
        (await configuredDiscovery(input.config, input.fetchFn)) ??
        (await discoverOAuthServerInfo(input.config.url, { fetchFn: input.fetchFn }))

      const tokenEndpoint = discovery.authorizationServerMetadata?.token_endpoint

      if (!tokenEndpoint) throw new Error("Authorization server metadata missing token_endpoint")
      const resource = selectResource(input.config.url, discovery.resourceMetadata?.resource).toString()

      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: oauth.clientId!,
        client_secret: oauth.clientSecret!,
        resource,
      })

      if (oauth.scope) body.set("scope", oauth.scope)

      const response = await input.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      })

      if (!response.ok) throw new Error(`Token endpoint returned HTTP ${response.status}`)
      const decodedPayload = decodeTokenResponse(await response.json())

      if (Option.isNone(decodedPayload)) throw new Error("Token response missing access_token")
      const payload = decodedPayload.value

      return toVaultEntry({
        serverUrl: input.config.url,
        tokens: payload,
        clientInfo: { client_id: oauth.clientId!, client_secret: oauth.clientSecret },
        issuer: discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl,
        discovery: { authorizationServer: discovery.authorizationServerUrl, resource },
        now,
      })
    },
    catch: (error) =>
      new OAuthFlowError({
        server: input.server,
        message: error instanceof Error ? error.message : String(error),
      }),
  })

  yield* input.vault
    .set(input.server, input.config.url, entry)
    .pipe(Effect.mapError((error) => new OAuthFlowError({ server: input.server, message: error.message })))

  return entry
})

interface PendingFlow {
  readonly server: string
  readonly config: Mcp.RemoteServerConfig
  readonly state: string
  readonly expiresAt: number
  readonly oauthProvider: OAuthClientProvider
  readonly discovery: OAuthDiscoveryState
  readonly fetchFn: FetchLike
  readonly scope: string | undefined
  readonly closeServer: () => void
  readonly getTokens: () => StoredOAuthTokens | undefined
  readonly getClient: () => StoredOAuthClientInformation | undefined
}

export interface AuthManager {
  readonly authStart: (
    server: string,
    config: Mcp.RemoteServerConfig,
  ) => Effect.Effect<Mcp.AuthStartResult, OAuthFlowError>
  readonly authComplete: (
    server: string,
    redirectUrlOrCode: string,
    explicitState?: string,
  ) => Effect.Effect<Mcp.AuthCompleteResult, OAuthFlowError>
  readonly setToken: (
    server: string,
    config: Mcp.RemoteServerConfig,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    scope?: string,
  ) => Effect.Effect<Mcp.AuthCompleteResult, OAuthFlowError>
  readonly logout: (server: string, config: Mcp.RemoteServerConfig) => Effect.Effect<void, OAuthFlowError>
  readonly closeAll: Effect.Effect<void>
}

export const makeAuthManager = (options: {
  readonly vault: McpVault.Interface
  readonly baseFetch?: FetchLike
  readonly enableLoopback?: boolean
}): AuthManager => {
  const pending = new Map<string, PendingFlow>()

  const cleanupFlow = (server: string) => {
    const existing = pending.get(server)

    if (!existing) return
    pending.delete(server)
    existing.closeServer()
  }

  const finishExchange = Effect.fn("McpOAuth.finishExchange")(function* (
    flow: PendingFlow,
    code: string,
    iss: string | undefined,
  ): Effect.fn.Return<Mcp.AuthCompleteResult, OAuthFlowError> {
    yield* Effect.tryPromise({
      try: () =>
        auth(flow.oauthProvider, {
          serverUrl: flow.config.url,
          authorizationCode: code,
          ...(iss !== undefined && { iss }),
          ...(flow.scope !== undefined && { scope: flow.scope }),
          fetchFn: flow.fetchFn,
        }),
      catch: (error) =>
        new OAuthFlowError({
          server: flow.server,
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    const tokens = flow.getTokens()

    if (!tokens) {
      return yield* new OAuthFlowError({
        server: flow.server,
        message: `MCP server "${flow.server}" did not return OAuth tokens`,
      })
    }

    const now = yield* Clock.currentTimeMillis
    const oauth = flow.config.oauth || undefined
    const issuer = flow.discovery.authorizationServerMetadata?.issuer ?? flow.discovery.authorizationServerUrl
    const resource = selectResource(flow.config.url, flow.discovery.resourceMetadata?.resource).toString()

    const entry = toVaultEntry({
      serverUrl: flow.config.url,
      tokens,
      clientInfo: flow.getClient(),
      issuer,
      discovery: oauth?.authServerMetadataUrl
        ? undefined
        : { authorizationServer: flow.discovery.authorizationServerUrl, resource },
      now,
    })

    yield* options.vault
      .set(flow.server, flow.config.url, entry)
      .pipe(Effect.mapError((error) => new OAuthFlowError({ server: flow.server, message: error.message })))

    cleanupFlow(flow.server)

    return {
      server: decodeServerName(flow.server),
      authenticated: true,
      ...(entry.tokens?.scope !== undefined && { scope: entry.tokens.scope }),
      ...(entry.tokens?.expiresAt !== undefined && { expiresAt: entry.tokens.expiresAt }),
    }
  })

  interface FlowStoreState {
    tokens: StoredOAuthTokens | undefined
    client: StoredOAuthClientInformation | undefined
    verifier: string | undefined
    discovery: OAuthDiscoveryState | undefined
    authorizationUrl: URL | undefined
  }

  const authStart = Effect.fn("McpOAuth.authStart")(function* (
    server: string,
    config: Mcp.RemoteServerConfig,
  ): Effect.fn.Return<Mcp.AuthStartResult, OAuthFlowError> {
    cleanupFlow(server)

    if (config.oauth === false) {
      return yield* new OAuthFlowError({ server, message: "OAuth is disabled for this server" })
    }

    const oauth = config.oauth || undefined

    const fetchFn = createScopedFetch({
      serverUrl: config.url,
      customHeaders: config.headers,
      baseFetch: options.baseFetch,
    })

    const state = crypto.randomBytes(32).toString("base64url")
    const now = yield* Clock.currentTimeMillis
    const expiresAt = now + PENDING_FLOW_TTL_MS

    const storeState: FlowStoreState = {
      tokens: undefined,
      client: undefined,
      verifier: undefined,
      discovery: undefined,
      authorizationUrl: undefined,
    }

    const existing = yield* options.vault.get(server, config.url).pipe(Effect.orElseSucceed(() => undefined))

    if (existing?.clientInfo) {
      storeState.client = {
        client_id: existing.clientInfo.clientId,
        ...(existing.clientInfo.clientSecret !== undefined && { client_secret: existing.clientInfo.clientSecret }),
      }
    }

    const redirectParsed = oauth?.redirectUri ? new URL(oauth.redirectUri) : undefined
    const redirectPath = redirectParsed?.pathname ?? "/callback"
    let callbackPort: number | undefined
    let httpServer: http.Server | undefined

    if (options.enableLoopback !== false) {
      const listener = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ readonly server: http.Server; readonly port: number }>((resolve, reject) => {
            const srv = http.createServer((req, res) => {
              const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1")

              if (reqUrl.pathname !== redirectPath) {
                res.writeHead(404).end("Not found")

                return
              }

              const flow = pending.get(server)

              if (!flow) {
                res.writeHead(410).end("OAuth flow expired or already completed")

                return
              }

              const errorParam = reqUrl.searchParams.get("error_description") ?? reqUrl.searchParams.get("error")

              if (errorParam) {
                res.writeHead(400).end(`OAuth error: ${errorParam}`)

                return
              }

              const returnedState = reqUrl.searchParams.get("state")
              const code = reqUrl.searchParams.get("code")

              if (returnedState !== flow.state || !code) {
                res.writeHead(400).end("Invalid OAuth state or missing code")

                return
              }

              Effect.runPromise(
                finishExchange(flow, code, reqUrl.searchParams.get("iss") ?? undefined).pipe(
                  Effect.match({
                    onFailure: (error) => {
                      res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error.message}`)
                    },
                    onSuccess: () => {
                      res
                        .writeHead(200, { "content-type": "text/plain" })
                        .end("Authorization complete. You may close this tab.")
                    },
                  }),
                ),
              )
            })

            srv.once("error", reject)
            const requestedPort = oauth?.callbackPort ?? (Number(redirectParsed?.port) || 0)
            srv.listen(requestedPort, "127.0.0.1", () => {
              const addr = srv.address()

              if (addr && !Predicate.isString(addr)) {
                resolve({ server: srv, port: addr.port })
              } else {
                reject(new Error("Failed to bind loopback callback server"))
              }
            })
          }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))

      if (listener) {
        httpServer = listener.server
        callbackPort = listener.port
      }
    }

    const closeServer = () => {
      if (httpServer) {
        httpServer.close()
        httpServer = undefined
      }
    }

    const challenge = yield* Effect.tryPromise({
      try: () =>
        fetchFn(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "vibest" } },
          }),
        }).then((res) => extractWWWAuthenticateParams(res)),
      catch: () => undefined,
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ({ resourceMetadataUrl: undefined, scope: undefined })),
    )

    const discovery = yield* Effect.tryPromise({
      try: async () =>
        (await configuredDiscovery(config, fetchFn)) ??
        discoverOAuthServerInfo(config.url, {
          ...(challenge.resourceMetadataUrl !== undefined && { resourceMetadataUrl: challenge.resourceMetadataUrl }),
          fetchFn,
        }),
      catch: (error) =>
        new OAuthFlowError({
          server,
          message: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(Effect.tapError(() => Effect.sync(closeServer)))

    storeState.discovery = {
      ...discovery,
      ...(challenge.resourceMetadataUrl !== undefined && {
        resourceMetadataUrl: challenge.resourceMetadataUrl.toString(),
      }),
    }

    const useCimd =
      !oauth?.clientId &&
      Boolean(oauth?.clientMetadataUrl) &&
      discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true

    const redirectUrl =
      oauth?.redirectUri ??
      (callbackPort !== undefined ? `http://127.0.0.1:${callbackPort}${redirectPath}` : "http://127.0.0.1:0/callback")

    const staticClient = oauth?.clientId
      ? {
          client_id: oauth.clientId,
          ...(oauth.clientSecret !== undefined && { client_secret: oauth.clientSecret }),
        }
      : undefined

    const oauthProvider: OAuthClientProvider = {
      get redirectUrl() {
        return redirectUrl
      },
      discoveryState: async () => storeState.discovery,
      saveDiscoveryState: (next) => {
        storeState.discovery = next
      },
      validateResourceURL: async (_serverUrl, resource) => selectResource(config.url, resource),
      ...(useCimd && oauth?.clientMetadataUrl !== undefined && { clientMetadataUrl: oauth.clientMetadataUrl }),
      state: () => state,
      clientMetadata: {
        redirect_uris: [redirectUrl],
        client_name: "vibest",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: staticClient?.client_secret ? "client_secret_post" : "none",
        ...(oauth?.scope !== undefined && { scope: oauth.scope }),
      },
      clientInformation: async () => staticClient ?? storeState.client,
      saveClientInformation: async (info) => {
        storeState.client = info
      },
      tokens: async () => storeState.tokens,
      saveTokens: async (tokens) => {
        storeState.tokens = tokens
      },
      redirectToAuthorization: (url) => {
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`Unsupported OAuth authorization URL protocol: ${url.protocol}`)
        }

        if (oauth?.authorizationParams) {
          for (const [k, v] of Object.entries(oauth.authorizationParams)) {
            url.searchParams.set(k, v)
          }
        }

        storeState.authorizationUrl = url
      },
      saveCodeVerifier: async (verifier) => {
        storeState.verifier = verifier
      },
      codeVerifier: async () => {
        if (!storeState.verifier) throw new Error("Missing PKCE code verifier")

        return storeState.verifier
      },
    }

    const effectiveScope = oauth?.scope ?? challenge.scope

    yield* Effect.tryPromise({
      try: () =>
        auth(oauthProvider, {
          serverUrl: config.url,
          ...(effectiveScope !== undefined && { scope: effectiveScope }),
          fetchFn,
        }),
      catch: (error) =>
        new OAuthFlowError({
          server,
          message: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(Effect.tapError(() => Effect.sync(closeServer)))

    if (!storeState.authorizationUrl) {
      closeServer()

      return yield* new OAuthFlowError({
        server,
        message: `MCP server "${server}" did not produce an authorization URL`,
      })
    }

    const flow: PendingFlow = {
      server,
      config,
      state,
      expiresAt,
      oauthProvider,
      discovery,
      fetchFn,
      scope: effectiveScope,
      closeServer,
      getTokens: () => storeState.tokens,
      getClient: () => staticClient ?? storeState.client,
    }

    pending.set(server, flow)

    return {
      server: decodeServerName(server),
      authorizationUrl: storeState.authorizationUrl.toString(),
      state,
      expiresAt,
      ...(callbackPort !== undefined && { callbackUrl: redirectUrl }),
    }
  })

  const authComplete = Effect.fn("McpOAuth.authComplete")(function* (
    server: string,
    redirectUrlOrCode: string,
    explicitState?: string,
  ): Effect.fn.Return<Mcp.AuthCompleteResult, OAuthFlowError> {
    const flow = pending.get(server)

    if (!flow) {
      return yield* new OAuthFlowError({ server, message: `No pending OAuth flow for server "${server}"` })
    }

    const now = yield* Clock.currentTimeMillis

    if (now > flow.expiresAt) {
      cleanupFlow(server)

      return yield* new OAuthFlowError({ server, message: `OAuth flow for server "${server}" has expired` })
    }

    let code: string | undefined
    let returnedState: string | undefined = explicitState
    let iss: string | undefined
    const trimmed = redirectUrlOrCode.trim()

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parsed = new URL(trimmed)
      const errorParam = parsed.searchParams.get("error_description") ?? parsed.searchParams.get("error")

      if (errorParam) {
        cleanupFlow(server)

        return yield* new OAuthFlowError({ server, message: `Authorization error: ${errorParam}` })
      }

      code = parsed.searchParams.get("code") ?? undefined
      returnedState = parsed.searchParams.get("state") ?? returnedState
      iss = parsed.searchParams.get("iss") ?? undefined
    } else {
      code = trimmed
    }

    if (!code) {
      return yield* new OAuthFlowError({ server, message: "Missing authorization code" })
    }

    if (returnedState !== flow.state) {
      return yield* new OAuthFlowError({ server, message: "OAuth state mismatch" })
    }

    return yield* finishExchange(flow, code, iss)
  })

  const setToken = Effect.fn("McpOAuth.setToken")(function* (
    server: string,
    config: Mcp.RemoteServerConfig,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    scope?: string,
  ): Effect.fn.Return<Mcp.AuthCompleteResult, OAuthFlowError> {
    const now = yield* Clock.currentTimeMillis

    const entry: McpVault.CredentialEntry = {
      id: crypto.randomUUID(),
      serverUrl: McpVault.canonicalServerUrl(config.url),
      tokens: {
        accessToken,
        ...(refreshToken !== undefined && { refreshToken }),
        ...(expiresAt !== undefined && { expiresAt }),
        ...(scope !== undefined && { scope }),
      },
      updatedAt: now,
    }

    yield* options.vault
      .set(server, config.url, entry)
      .pipe(Effect.mapError((error) => new OAuthFlowError({ server, message: error.message })))

    return {
      server: decodeServerName(server),
      authenticated: true,
      ...(scope !== undefined && { scope }),
      ...(expiresAt !== undefined && { expiresAt }),
    }
  })

  const logout = Effect.fn("McpOAuth.logout")(function* (
    server: string,
    config: Mcp.RemoteServerConfig,
  ): Effect.fn.Return<void, OAuthFlowError> {
    cleanupFlow(server)
    yield* options.vault
      .remove(server, config.url)
      .pipe(Effect.mapError((error) => new OAuthFlowError({ server, message: error.message })))
  })

  const closeAll = Effect.sync(() => {
    for (const server of Array.from(pending.keys())) {
      cleanupFlow(server)
    }
  })

  return { authStart, authComplete, setToken, logout, closeAll }
}
