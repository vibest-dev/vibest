import { Taken } from "@vibest/schema/session"
import { PROTOCOL } from "@vibest/schema/version"
import { Option, Schema } from "effect"

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
export const TOKEN_HEADER = "vibest-token"
export const CALLER_HEADER = "vibest-caller"
export const SESSION_HEADER = "vibest-session-id"
export const REPOSITORY_HEADER = "vibest-repository"
export const PROJECT_HEADER = "vibest-project-id"
export const HARNESS_SESSION_HEADER = "vibest-harness-session-id"
export const HARNESS_HEADER = "vibest-harness"
export const CWD_HEADER = "vibest-cwd"
export const RUNTIME_HEADER = "vibest-runtime"
export const PLUGIN_VERSION_HEADER = "vibest-plugin-version"
export const PROCESS_HEADER = "vibest-process"
export const REMOTE_HEADER = "vibest-remote"
export const REMOTE_PROJECT_HEADER = "vibest-remote-project"

export const REMOTE_BY_HEADER = "vibest-remote-by"
export const REMOTE_BY_USER = "user"

export const remoteHeaders = (remote: string, project?: string, by?: string) => ({
  [PROTOCOL_HEADER]: String(PROTOCOL),
  [CALLER_HEADER]: "remote",
  [REMOTE_HEADER]: remote,
  ...(project !== undefined && { [REMOTE_PROJECT_HEADER]: project }),
  ...(by !== undefined && { [REMOTE_BY_HEADER]: by }),
})

export const TAKE_ROUTE = "/api/inbox/take"
export const READY_ROUTE = "/api/hook/ready"

const HOOK_KINDS = ["execution-end", "prompt", "guard"] as const

export type HookKind = (typeof HOOK_KINDS)[number]

export const hookRoute = (harness: string, hook: HookKind) => `/api/hook/${harness}/${hook}`

const decodeTaken = Schema.decodeUnknownOption(Taken)

export const isTaken = (body: unknown): body is Taken => Option.isSome(decodeTaken(body))

export type SessionIdentity = {
  readonly sessionId: string
  readonly projectId?: string | undefined
  readonly harnessSessionId?: string | undefined
  readonly harness?: string | undefined
  readonly cwd?: string | undefined
  readonly runtime?: string | undefined
  readonly pluginVersion?: string | undefined
  readonly process?: string | undefined
  readonly repositoryRoot?: string | undefined
}

const presentHeaders = (headers: ReadonlyArray<readonly [string, string | undefined]>) =>
  Object.fromEntries(headers.flatMap(([name, value]) => (value ? [[name, value] as const] : [])))

export const sessionHeaders = (who: SessionIdentity) => ({
  [PROTOCOL_HEADER]: String(PROTOCOL),
  [CALLER_HEADER]: "session",
  [SESSION_HEADER]: who.sessionId,
  ...presentHeaders([
    [PROJECT_HEADER, who.projectId],
    [HARNESS_SESSION_HEADER, who.harnessSessionId],
    [HARNESS_HEADER, who.harness],
    [CWD_HEADER, who.cwd === undefined ? undefined : encodeURIComponent(who.cwd)],
    [RUNTIME_HEADER, who.runtime],
    [PLUGIN_VERSION_HEADER, who.pluginVersion],
    [PROCESS_HEADER, who.process],
  ]),
  ...(who.repositoryRoot !== undefined && { [REPOSITORY_HEADER]: who.repositoryRoot }),
})

export const CAPABILITIES = {
  http: true,
  handoff: true,
  requests: true,
  watch: true,
  remoteWatch: true,
  events: true,
  projects: true,
  spawnRuntime: true,
  spawnFiles: true,
  remoteSpawnFiles: true,
  remoteSpawnRepositories: true,
  remoteSpawnProject: true,
  projectClone: true,
  load: true,
  agents: true,
  worktrees: true,
  stop: true,
  mcp: true,
  codemode: true,
} as const
