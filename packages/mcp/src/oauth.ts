import crypto from "node:crypto"

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
import { Clock, Duration, Effect, Fiber, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import { OAuthFlowError } from "./errors.ts"
import { startLoopbackListener } from "./oauth-callback.ts"
import { createScopedFetch, loggedFetch, MAX_HTTP_RESPONSE_BYTES } from "./oauth-fetch.ts"
import { McpSecrets } from "./secrets.ts"
import { McpVault } from "./vault.ts"

export * as McpOAuth from "./oauth.ts"

export { createScopedFetch, loggedFetch, MAX_HTTP_RESPONSE_BYTES }

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

const parseUrl = (raw: string, server: string, label: string): Effect.Effect<URL, OAuthFlowError> =>
  Effect.try({
    try: () => new URL(raw),
    catch: () => new OAuthFlowError({ server, message: `Invalid ${label} URL: ${raw}` }),
  })

const resolveRemoteSecrets = (
  server: string,
  config: Mcp.RemoteServerConfig,
): Effect.Effect<Mcp.RemoteServerConfig, OAuthFlowError, ChildProcessSpawner.ChildProcessSpawner> =>
  McpSecrets.resolveServerConfig(server, config).pipe(
    Effect.flatMap((resolved) =>
      resolved.type === "remote"
        ? Effect.succeed(resolved)
        : Effect.fail(new OAuthFlowError({ server, message: "Expected remote MCP server config" })),
    ),
    Effect.mapError((error) =>
      error instanceof OAuthFlowError ? error : new OAuthFlowError({ server, message: error.message }),
    ),
  )

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
  readonly server: string
  readonly config: Mcp.RemoteServerConfig
  readonly fetchFn: FetchLike
  readonly current: McpVault.CredentialEntry
  readonly resourceMetadataUrl: URL | undefined
  readonly now: number
}): Effect.Effect<
  McpVault.CredentialEntry,
  RefreshRejected | IssuerChanged | Error,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const resolvedConfig = yield* resolveRemoteSecrets(input.server, input.config).pipe(
      Effect.mapError((error) => new Error(error.message)),
    )

    return yield* Effect.tryPromise({
      try: async (signal) => {
        const fetchFn: FetchLike = async (url, init) => {
          const response = await input.fetchFn(url, { ...init, signal })

          if (
            init?.method === "POST" &&
            (response.status === 408 || response.status === 429 || response.status >= 500)
          ) {
            throw new Error(`HTTP ${response.status}`)
          }

          return response
        }

        const oauth = resolvedConfig.oauth || undefined

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
        const configured = await configuredDiscovery(resolvedConfig, fetchFn)

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
            : await discoverOAuthServerInfo(resolvedConfig.url, {
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

        const resource =
          saved?.resource ?? selectResource(resolvedConfig.url, server.resourceMetadata?.resource).toString()

        const tokens = await refreshAuthorization(server.authorizationServerUrl, {
          ...(server.authorizationServerMetadata !== undefined && { metadata: server.authorizationServerMetadata }),
          clientInformation: client,
          refreshToken,
          resource,
          fetchFn,
        })

        return toVaultEntry({
          serverUrl: resolvedConfig.url,
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
  })

interface PresentedTokenState {
  presented: string | undefined
}

export const connectProvider = Effect.fn("McpOAuth.connectProvider")(function* (input: {
  readonly server: string
  readonly config: Mcp.RemoteServerConfig
  readonly vault?: McpVault.Interface | undefined
  readonly fetchFn?: FetchLike | undefined
}): Effect.fn.Return<AuthProvider, never, McpVault.Service | ChildProcessSpawner.ChildProcessSpawner> {
  const vault = input.vault ?? (yield* McpVault.Service)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const context = yield* Effect.context()
  const run = Effect.runPromiseWith(context)

  if (input.config.bearerToken !== undefined) {
    const rawBearer = input.config.bearerToken

    return {
      token: () =>
        run(
          McpSecrets.resolveValue(rawBearer, `${input.server}.bearerToken`).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
    }
  }

  if (input.config.oauth === false) {
    return { token: async () => undefined }
  }

  const fetchFn =
    input.fetchFn ??
    (yield* loggedFetch({
      server: input.server,
      serverUrl: input.config.url,
      customHeaders: input.config.headers,
    }))

  const state: PresentedTokenState = { presented: undefined }
  const refused = () => new UnauthorizedError(`MCP server "${input.config.url}" requires user authorization`)

  return {
    token: () =>
      run(
        Effect.gen(function* () {
          const entry = yield* vault.get(input.server, input.config.url).pipe(Effect.orElseSucceed(() => undefined))

          if (!entry?.tokens) {
            state.presented = undefined

            return undefined
          }

          const now = yield* Clock.currentTimeMillis

          const expiringSoon =
            entry.tokens.expiresAt !== undefined &&
            entry.tokens.expiresAt > 0 &&
            now + REFRESH_AHEAD_MS >= entry.tokens.expiresAt

          if (expiringSoon && entry.tokens.refreshToken) {
            const refreshed = yield* vault
              .refresh(input.server, input.config.url, {
                presentedAccess: entry.tokens.accessToken,
                shouldRefresh: (cur) =>
                  cur.tokens?.expiresAt !== undefined &&
                  cur.tokens.expiresAt > 0 &&
                  now + REFRESH_AHEAD_MS >= cur.tokens.expiresAt,
                perform: (cur) =>
                  exchangeRefresh({
                    server: input.server,
                    config: input.config,
                    fetchFn,
                    current: cur,
                    resourceMetadataUrl: undefined,
                    now,
                  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
                shouldInvalidate: (error) => error instanceof RefreshRejected,
              })
              .pipe(Effect.orElseSucceed(() => entry))

            state.presented = refreshed?.tokens?.accessToken

            return state.presented
          }

          state.presented = entry.tokens.accessToken

          return state.presented
        }),
      ),
    onUnauthorized: (contextArg) =>
      run(
        Effect.gen(function* () {
          const rejected = state.presented
          const wwwAuth = extractWWWAuthenticateParams(contextArg.response)
          const now = yield* Clock.currentTimeMillis

          const refreshed = yield* vault
            .refresh(input.server, input.config.url, {
              presentedAccess: rejected,
              perform: (cur) =>
                exchangeRefresh({
                  server: input.server,
                  config: input.config,
                  fetchFn,
                  current: cur,
                  resourceMetadataUrl: wwwAuth.resourceMetadataUrl,
                  now,
                }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
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
            )

          if (!refreshed?.tokens?.accessToken) return yield* Effect.fail(refused())
        }),
      ),
  }
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
  readonly expiryFiber: Fiber.Fiber<void> | undefined
  readonly getTokens: () => StoredOAuthTokens | undefined
  readonly getClient: () => StoredOAuthClientInformation | undefined
}

interface FlowStoreState {
  tokens: StoredOAuthTokens | undefined
  client: StoredOAuthClientInformation | undefined
  verifier: string | undefined
  discovery: OAuthDiscoveryState | undefined
  authorizationUrl: URL | undefined
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

export const makeAuthManager = Effect.fn("McpOAuth.makeAuthManager")(function* (options?: {
  readonly vault?: McpVault.Interface | undefined
  readonly baseFetch?: FetchLike | undefined
  readonly enableLoopback?: boolean | undefined
  readonly pendingFlowTtlMs?: number | undefined
}): Effect.fn.Return<AuthManager, never, McpVault.Service | ChildProcessSpawner.ChildProcessSpawner> {
  const vault = options?.vault ?? (yield* McpVault.Service)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const contextFetch = yield* FetchHttpClient.Fetch
  const pending = new Map<string, PendingFlow>()
  const flowTtlMs = options?.pendingFlowTtlMs ?? PENDING_FLOW_TTL_MS

  const cleanupFlow = (server: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const existing = pending.get(server)

      if (!existing) return Effect.void
      pending.delete(server)
      existing.closeServer()

      return existing.expiryFiber ? Fiber.interrupt(existing.expiryFiber) : Effect.void
    })

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

    yield* vault
      .set(flow.server, flow.config.url, entry)
      .pipe(Effect.mapError((error) => new OAuthFlowError({ server: flow.server, message: error.message })))

    yield* cleanupFlow(flow.server)

    return {
      server: decodeServerName(flow.server),
      authenticated: true,
      ...(entry.tokens?.scope !== undefined && { scope: entry.tokens.scope }),
      ...(entry.tokens?.expiresAt !== undefined && { expiresAt: entry.tokens.expiresAt }),
    }
  })

  const authStart = Effect.fn("McpOAuth.authStart")(function* (
    server: string,
    rawConfig: Mcp.RemoteServerConfig,
  ): Effect.fn.Return<Mcp.AuthStartResult, OAuthFlowError> {
    yield* cleanupFlow(server)

    if (rawConfig.oauth === false) {
      return yield* new OAuthFlowError({ server, message: "OAuth is disabled for this server" })
    }

    yield* parseUrl(rawConfig.url, server, "server")

    const config = yield* resolveRemoteSecrets(server, rawConfig).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )

    const oauth = config.oauth || undefined

    const redirectParsed =
      oauth?.redirectUri !== undefined ? yield* parseUrl(oauth.redirectUri, server, "redirect") : undefined

    const fetchFn = yield* loggedFetch({
      server,
      serverUrl: config.url,
      customHeaders: config.headers,
      baseFetch: options?.baseFetch,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, contextFetch))

    const state = crypto.randomBytes(32).toString("base64url")
    const now = yield* Clock.currentTimeMillis
    const expiresAt = now + flowTtlMs

    const storeState: FlowStoreState = {
      tokens: undefined,
      client: undefined,
      verifier: undefined,
      discovery: undefined,
      authorizationUrl: undefined,
    }

    const existing = yield* vault.get(server, config.url).pipe(Effect.orElseSucceed(() => undefined))

    if (existing?.clientInfo) {
      storeState.client = {
        client_id: existing.clientInfo.clientId,
        ...(existing.clientInfo.clientSecret !== undefined && { client_secret: existing.clientInfo.clientSecret }),
      }
    }

    const redirectPath = redirectParsed?.pathname ?? "/callback"

    const loopback =
      options?.enableLoopback !== false
        ? yield* startLoopbackListener({
            redirectPath,
            requestedPort: oauth?.callbackPort ?? (Number(redirectParsed?.port) || 0),
            expectedState: state,
            onCallback: (code, iss) => {
              const active = pending.get(server)

              if (!active) return Effect.fail({ message: "OAuth flow expired or already completed" })

              return finishExchange(active, code, iss).pipe(Effect.asVoid)
            },
          })
        : undefined

    const closeServer = () => {
      loopback?.close()
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
      (loopback !== undefined ? `http://127.0.0.1:${loopback.port}${redirectPath}` : "http://127.0.0.1:0/callback")

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

    const expiryFiber = yield* Effect.forkDetach(
      Effect.sleep(Duration.millis(flowTtlMs)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const current = pending.get(server)

            if (current && current.state === state) {
              pending.delete(server)
              current.closeServer()
            }
          }),
        ),
      ),
    )

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
      expiryFiber,
      getTokens: () => storeState.tokens,
      getClient: () => staticClient ?? storeState.client,
    }

    pending.set(server, flow)

    return {
      server: decodeServerName(server),
      authorizationUrl: storeState.authorizationUrl.toString(),
      state,
      expiresAt,
      ...(loopback !== undefined && { callbackUrl: redirectUrl }),
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
      yield* cleanupFlow(server)

      return yield* new OAuthFlowError({ server, message: `OAuth flow for server "${server}" has expired` })
    }

    let code: string | undefined
    let returnedState: string | undefined = explicitState
    let iss: string | undefined
    const trimmed = redirectUrlOrCode.trim()

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parsed = yield* parseUrl(trimmed, server, "callback")
      const errorParam = parsed.searchParams.get("error_description") ?? parsed.searchParams.get("error")

      if (errorParam) {
        yield* cleanupFlow(server)

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
    yield* parseUrl(config.url, server, "server")
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

    yield* vault
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
    yield* cleanupFlow(server)
    yield* parseUrl(config.url, server, "server")
    yield* vault
      .remove(server, config.url)
      .pipe(Effect.mapError((error) => new OAuthFlowError({ server, message: error.message })))
  })

  const closeAll = Effect.forEach(Array.from(pending.keys()), cleanupFlow, { discard: true })

  return { authStart, authComplete, setToken, logout, closeAll }
})
