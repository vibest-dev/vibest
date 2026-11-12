export const PROTOCOL = 10

export const MISMATCH_ACTION = "vibest update"

export type ProtocolMismatch = {
  readonly protocol: number
  readonly version: string
  readonly message: string
  readonly action: string
}

export const protocolMismatch = (
  caller: number | undefined,
  server: number,
  version: string,
  callerVersion?: string,
): ProtocolMismatch => ({
  protocol: server,
  version,
  message:
    caller !== undefined && caller > server
      ? `vibestd is older (${version}); run ${MISMATCH_ACTION}`
      : `this agent runs ${callerVersion ? `vibest ${callerVersion}` : "an older vibest"} (protocol ${caller ?? "none"}), vibestd runs ${version} (protocol ${server}); run ${MISMATCH_ACTION} to restart this agent on it`,
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
export const PROCESS_HEADER = "vibest-process"
export const PEER_HEADER = "vibest-peer"
export const PEER_PROJECT_HEADER = "vibest-peer-project"

export const PEER_BY_HEADER = "vibest-peer-by"
export const PEER_BY_USER = "user"

export const peerHeaders = (peer: string, project?: string, by?: string): Record<string, string> => ({
  [PROTOCOL_HEADER]: String(PROTOCOL),
  [CALLER_HEADER]: "peer",
  [PEER_HEADER]: peer,
  ...(project === undefined ? {} : { [PEER_PROJECT_HEADER]: project }),
  ...(by === undefined ? {} : { [PEER_BY_HEADER]: by }),
})

export const TAKE_ROUTE = "/inbox/take"
export type HookKind = "execution-end" | "prompt" | "guard"
export const hookRoute = (harness: string, hook: HookKind) => `/hooks/${harness}/${hook}`
export const parseHookRoute = (path: string): { readonly harness: string; readonly hook: HookKind } | undefined => {
  const m = /^\/hooks\/([a-z]+)\/(execution-end|prompt|guard)$/.exec(path)
  return m ? { harness: m[1]!, hook: m[2] as HookKind } : undefined
}

export type Taken = {
  readonly execution: number
  readonly ids: ReadonlyArray<number>
  readonly line: string
  readonly text: string
}
export const isTaken = (body: unknown): body is Taken =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as Taken).execution === "number" &&
  Array.isArray((body as Taken).ids) &&
  typeof (body as Taken).line === "string" &&
  typeof (body as Taken).text === "string"

export type SessionIdentity = {
  readonly sessionId: string
  readonly projectId?: string | undefined
  readonly harnessSessionId?: string | undefined
  readonly agent?: string | undefined
  readonly harness?: string | undefined
  readonly cwd?: string | undefined
  readonly runtime?: string | undefined
  readonly pluginVersion?: string | undefined
  readonly process?: string | undefined
  readonly repositoryRoot?: string | undefined
}

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
  put(PROCESS_HEADER, who.process)
  if (who.repositoryRoot !== undefined) headers[REPOSITORY_HEADER] = who.repositoryRoot
  return headers
}
