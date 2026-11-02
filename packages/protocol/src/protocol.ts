/**
 * Wire protocol, the only version, for RPC and HTTP alike (the `vibest-protocol` header; HTTP paths carry none).
 * Independent of the package version in package.json. Bump only when a request a current daemon accepts would be
 * misunderstood; old versions are not served. An additive feature does not bump it: it gets a flag in Ping's
 * `capabilities`, and a client uses it only when the flag is there.
 */
export const PROTOCOL = 3

/**
 * What the user runs to continue after a protocol mismatch. The one place to swap them: the restart-and-resume command
 * is still being designed, so these are the best commands that exist today.
 */
export const MISMATCH_ACTION = {
  /** The caller is older than vibestd: quit the agent, then reopen the project's main agent with its conversation. */
  restartAgent: "vibest",
  /** vibestd is older than the caller: replace it with the vibest on PATH. */
  upgradeDaemon: "vibest daemon restart",
} as const

/** vibestd's answer to a request in another protocol (HTTP 409 body, RPC ProtocolRejected, the CLI's preflight). */
export type ProtocolMismatch = {
  /** vibestd's PROTOCOL. */
  readonly protocol: number
  /** vibestd's package version. */
  readonly version: string
  readonly message: string
  /** The command to run. */
  readonly action: string
}

/**
 * The mismatch between a caller speaking `caller` (undefined: it sent none, so it predates the header) and a vibestd
 * speaking `server` at package `version`. A caller below vibestd was left behind by an update; above it, vibestd is old.
 */
export const protocolMismatch = (caller: number | undefined, server: number, version: string): ProtocolMismatch =>
  caller !== undefined && caller > server
    ? {
        protocol: server,
        version,
        message: `vibestd is older (${version}); upgrade it`,
        action: MISMATCH_ACTION.upgradeDaemon,
      }
    : {
        protocol: server,
        version,
        message: `vibest was updated to ${version}; restart this agent to continue`,
        action: MISMATCH_ACTION.restartAgent,
      }

/** One line for a person: the message and the command. */
export const mismatchText = (m: Pick<ProtocolMismatch, "message" | "action">) => `${m.message}. Run: ${m.action}`

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
 * A session's request without `vibest-project-id`, over RPC or HTTP alike: refused until the owner decides otherwise.
 * Unconfirmed default, kept in this one place so it can flip to "allow".
 */
export const MISSING_PROJECT_ID: "refuse" | "allow" = "refuse"

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
