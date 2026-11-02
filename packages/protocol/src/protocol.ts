/**
 * Wire protocol, the only version, for RPC and HTTP alike (the `vibest-protocol` header; HTTP paths carry none).
 * Independent of the package version in package.json. Bump only when a request a current daemon accepts would be
 * misunderstood; old versions are not served. An additive feature does not bump it: it gets a flag in Ping's
 * `capabilities`, and a client uses it only when the flag is there.
 */
export const PROTOCOL = 4

/**
 * What the user runs after a protocol mismatch, either way: `vibest update` brings vibest, vibestd and the agents
 * running on them to one version, restarting the agents. The one place to change it.
 */
export const MISMATCH_ACTION = "vibest update"

/** vibestd's answer to a request in another protocol (HTTP 409 body, RPC ProtocolRejected, the CLI's preflight). */
export type ProtocolMismatch = {
  /** vibestd's PROTOCOL. */
  readonly protocol: number
  /** vibestd's package version. */
  readonly version: string
  /** For a person; it names the action. */
  readonly message: string
  /** The command to run. */
  readonly action: string
}

/**
 * The mismatch between a caller speaking `caller` (undefined: it sent none, so it predates the header) and a vibestd
 * speaking `server` at package `version`. A caller below vibestd was left behind by an update; above it, vibestd is old.
 */
export const protocolMismatch = (caller: number | undefined, server: number, version: string): ProtocolMismatch => ({
  protocol: server,
  version,
  message:
    caller !== undefined && caller > server
      ? `vibestd is older (${version}); run ${MISMATCH_ACTION}`
      : `vibest was updated to ${version}; run ${MISMATCH_ACTION} to restart this agent on it`,
  action: MISMATCH_ACTION,
})

export const PROTOCOL_HEADER = "vibest-protocol"
export const CALLER_HEADER = "vibest-caller"
export const SESSION_HEADER = "vibest-session-id"
export const REPOSITORY_HEADER = "vibest-repository"
export const PROJECT_HEADER = "vibest-project-id"
export const HARNESS_SESSION_HEADER = "vibest-harness-session-id"
export const AGENT_HEADER = "vibest-agent"
export const HARNESS_HEADER = "vibest-harness"
export const CWD_HEADER = "vibest-cwd"
export const RUNTIME_HEADER = "vibest-runtime"
export const PLUGIN_VERSION_HEADER = "vibest-plugin-version"

/**
 * vibestd's HTTP routes (`vibest-http.sock`, every one `POST` with a JSON body). One definition for vibestd and the
 * harness integrations that bundle this file.
 */
export const POLL_ROUTE = "/inbox/poll"
export const ACK_ROUTE = "/inbox/ack"
export type HookKind = "turn-end" | "prompt" | "guard"
export const hookRoute = (harness: string, hook: HookKind) => `/hooks/${harness}/${hook}`
/** The harness and hook a path names, or undefined. */
export const parseHookRoute = (path: string): { readonly harness: string; readonly hook: HookKind } | undefined => {
  const m = /^\/hooks\/([a-z]+)\/(turn-end|prompt|guard)$/.exec(path)
  return m ? { harness: m[1]!, hook: m[2] as HookKind } : undefined
}

/** `POLL_ROUTE`'s answer: the main agent's next batch, leased (empty `ids`: none). */
export type Polled = { readonly ids: ReadonlyArray<number>; readonly line: string; readonly text: string }
export const isPolled = (body: unknown): body is Polled =>
  typeof body === "object" &&
  body !== null &&
  Array.isArray((body as Polled).ids) &&
  typeof (body as Polled).line === "string" &&
  typeof (body as Polled).text === "string"

/**
 * `ACK_ROUTE`'s body: `ids` were shown (delivered); `release` were handed out but not shown, so they go back to pending
 * at once (a batch that mixed a row already shown with a new one).
 */
export type AckBody = { readonly ids: ReadonlyArray<number>; readonly release?: ReadonlyArray<number> }

/**
 * Who a session's request comes from, as its environment and harness know it: VIBEST_SESSION_ID, VIBEST_PROJECT_ID,
 * the harness's own conversation id, VIBEST_AGENT, VIBEST_HARNESS, the working directory, VIBEST_RUNTIME (opaque) and
 * the integration's version. vibestd checks the session and project ids, records the conversation id and the version,
 * and only logs the rest.
 */
export type SessionIdentity = {
  readonly sessionId: string
  readonly projectId?: string | undefined
  readonly harnessSessionId?: string | undefined
  readonly agent?: string | undefined
  readonly harness?: string | undefined
  readonly cwd?: string | undefined
  readonly runtime?: string | undefined
  readonly pluginVersion?: string | undefined
  readonly repositoryRoot?: string | undefined
}

/**
 * The headers of a session's request, for every caller (the vibest CLI, the Pi extension, the Claude plugin's HTTP):
 * one definition, no dependencies, so a harness integration bundles it. Empty values are left out.
 */
export const sessionHeaders = (who: SessionIdentity): Record<string, string> => {
  const headers: Record<string, string> = {
    [PROTOCOL_HEADER]: String(PROTOCOL),
    [CALLER_HEADER]: "session",
    [SESSION_HEADER]: who.sessionId,
  }
  const put = (name: string, value: string | undefined) => {
    if (value) headers[name] = value
  }
  put(PROJECT_HEADER, who.projectId)
  put(HARNESS_SESSION_HEADER, who.harnessSessionId)
  put(AGENT_HEADER, who.agent)
  put(HARNESS_HEADER, who.harness)
  put(CWD_HEADER, who.cwd === undefined ? undefined : encodeURIComponent(who.cwd))
  put(RUNTIME_HEADER, who.runtime)
  put(PLUGIN_VERSION_HEADER, who.pluginVersion)
  if (who.repositoryRoot !== undefined) headers[REPOSITORY_HEADER] = who.repositoryRoot
  return headers
}
