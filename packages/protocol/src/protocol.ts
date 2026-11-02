/** Wire protocol. Independent of the package version in package.json. Bump only when a request a current daemon accepts would be misunderstood. */
export const PROTOCOL = 3

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
