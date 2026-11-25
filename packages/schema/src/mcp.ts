import { Schema } from "effect"

export * as Mcp from "./mcp.ts"

export const ServerName = Schema.NonEmptyString.pipe(Schema.brand("Mcp.ServerName")).annotate({
  identifier: "McpServerName",
})

export type ServerName = typeof ServerName.Type

export const Protocol = Schema.Literals(["legacy", "auto", "2026-07-28"]).annotate({
  identifier: "McpProtocol",
})

export type Protocol = typeof Protocol.Type

export const ExposureMode = Schema.Literals(["skill", "router", "direct"]).annotate({
  identifier: "McpExposureMode",
})

export type ExposureMode = typeof ExposureMode.Type

export const TimeoutConfig = Schema.Struct({
  startup: Schema.optional(Schema.Number),
  catalog: Schema.optional(Schema.Number),
  execution: Schema.optional(Schema.Number),
}).annotate({ identifier: "McpTimeoutConfig" })

export type TimeoutConfig = typeof TimeoutConfig.Type

export const LocalServerConfig = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  disabled: Schema.optional(Schema.Boolean),
  exposure: Schema.optional(ExposureMode),
  idleTimeoutMs: Schema.optional(Schema.Number),
  pool: Schema.optional(Schema.Boolean),
  codemode: Schema.optional(Schema.Boolean),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
  protocol: Schema.optional(Protocol),
  timeout: Schema.optional(TimeoutConfig),
}).annotate({ identifier: "McpLocalServerConfig" })

export type LocalServerConfig = typeof LocalServerConfig.Type

export const OAuthConfig = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  clientMetadataUrl: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  callbackPort: Schema.optional(Schema.Number),
  redirectUri: Schema.optional(Schema.String),
  authServerMetadataUrl: Schema.optional(Schema.String),
  authorizationParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  skipIssuerValidation: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "McpOAuthConfig" })

export type OAuthConfig = typeof OAuthConfig.Type

export const RemoteServerConfig = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.NonEmptyString,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  bearerToken: Schema.optional(Schema.String),
  oauth: Schema.optional(Schema.Union([OAuthConfig, Schema.Literal(false)])),
  disabled: Schema.optional(Schema.Boolean),
  exposure: Schema.optional(ExposureMode),
  idleTimeoutMs: Schema.optional(Schema.Number),
  pool: Schema.optional(Schema.Boolean),
  codemode: Schema.optional(Schema.Boolean),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
  protocol: Schema.optional(Protocol),
  timeout: Schema.optional(TimeoutConfig),
}).annotate({ identifier: "McpRemoteServerConfig" })

export type RemoteServerConfig = typeof RemoteServerConfig.Type

export const ServerConfig = Schema.Union([LocalServerConfig, RemoteServerConfig]).annotate({
  identifier: "McpServerConfig",
})

export type ServerConfig = typeof ServerConfig.Type

export const ConfigFile = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, ServerConfig),
}).annotate({ identifier: "McpConfigFile" })

export type ConfigFile = typeof ConfigFile.Type

export const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "McpStatusConnected",
})

export const StatusPending = Schema.Struct({ status: Schema.Literal("pending") }).annotate({
  identifier: "McpStatusPending",
})

export const StatusIdle = Schema.Struct({ status: Schema.Literal("idle") }).annotate({
  identifier: "McpStatusIdle",
})

export const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "McpStatusDisabled",
})

export const StatusFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
}).annotate({ identifier: "McpStatusFailed" })

export const StatusNeedsAuth = Schema.Struct({
  status: Schema.Literal("needs_auth"),
  error: Schema.String,
  requiredScope: Schema.optional(Schema.String),
}).annotate({ identifier: "McpStatusNeedsAuth" })

export const Status = Schema.Union([
  StatusConnected,
  StatusPending,
  StatusIdle,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
]).annotate({ identifier: "McpStatus" })

export type Status = typeof Status.Type

export const ServerInfo = Schema.Struct({
  name: ServerName,
  type: Schema.Literals(["local", "remote"]),
  exposure: ExposureMode,
  status: Status,
  title: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  toolCount: Schema.Number,
  pooled: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "McpServerInfo" })

export type ServerInfo = typeof ServerInfo.Type

export const ToolInfo = Schema.Struct({
  server: ServerName,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  signature: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
  outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "McpToolInfo" })

export type ToolInfo = typeof ToolInfo.Type

export const EventType = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  delivery: Schema.optional(Schema.Array(Schema.String)),
  inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  payloadSchema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "McpEventType" })

export type EventType = typeof EventType.Type

export const EventError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Json),
}).annotate({ identifier: "McpEventError" })

export type EventError = typeof EventError.Type

export const EventMessageActive = Schema.Struct({
  type: Schema.Literal("active"),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
}).annotate({ identifier: "McpEventMessageActive" })

export const EventMessageItem = Schema.Struct({
  type: Schema.Literal("event"),
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Json,
  cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "McpEventMessageItem" })

export const EventMessageHeartbeat = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "McpEventMessageHeartbeat" })

export const EventMessageError = Schema.Struct({
  type: Schema.Literal("error"),
  error: EventError,
}).annotate({ identifier: "McpEventMessageError" })

export const EventMessage = Schema.Union([
  EventMessageActive,
  EventMessageItem,
  EventMessageHeartbeat,
  EventMessageError,
]).annotate({ identifier: "McpEventMessage" })

export type EventMessage = typeof EventMessage.Type

export const ResourceInfo = Schema.Struct({
  server: ServerName,
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "McpResourceInfo" })

export type ResourceInfo = typeof ResourceInfo.Type

export const CallContentText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "McpCallContentText" })

export const CallContentMedia = Schema.Struct({
  type: Schema.Literal("media"),
  data: Schema.String,
  mimeType: Schema.String,
  uri: Schema.optional(Schema.String),
}).annotate({ identifier: "McpCallContentMedia" })

export const CallContent = Schema.Union([CallContentText, CallContentMedia]).annotate({
  identifier: "McpCallContent",
})

export type CallContent = typeof CallContent.Type

export const CallResult = Schema.Struct({
  isError: Schema.Boolean,
  structured: Schema.optional(Schema.Json),
  content: Schema.Array(CallContent),
  truncated: Schema.optional(Schema.Boolean),
  outputFile: Schema.optional(Schema.String),
}).annotate({ identifier: "McpCallResult" })

export type CallResult = typeof CallResult.Type

export const AuthStartResult = Schema.Struct({
  server: ServerName,
  authorizationUrl: Schema.String,
  state: Schema.String,
  expiresAt: Schema.Number,
  callbackUrl: Schema.optional(Schema.String),
}).annotate({ identifier: "McpAuthStartResult" })

export type AuthStartResult = typeof AuthStartResult.Type

export const AuthCompleteResult = Schema.Struct({
  server: ServerName,
  authenticated: Schema.Boolean,
  scope: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "McpAuthCompleteResult" })

export type AuthCompleteResult = typeof AuthCompleteResult.Type

export const SkillSyncEntry = Schema.Struct({
  server: ServerName,
  skillPath: Schema.String,
  toolCount: Schema.Number,
}).annotate({ identifier: "McpSkillSyncEntry" })

export type SkillSyncEntry = typeof SkillSyncEntry.Type

export const SkillSyncResult = Schema.Struct({
  synced: Schema.Array(SkillSyncEntry),
  removed: Schema.Array(Schema.String),
}).annotate({ identifier: "McpSkillSyncResult" })

export type SkillSyncResult = typeof SkillSyncResult.Type

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "McpNotFoundError",
  {
    server: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()(
  "McpToolNotFoundError",
  {
    server: Schema.String,
    tool: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ToolCallError extends Schema.TaggedError<ToolCallError>()(
  "McpToolCallError",
  {
    server: Schema.String,
    tool: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export class AuthError extends Schema.TaggedError<AuthError>()(
  "McpAuthError",
  {
    server: Schema.String,
    message: Schema.String,
    requiredScope: Schema.optional(Schema.String),
  },
  { httpApiStatus: 401 },
) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "McpConfigError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
