import { Schema } from "effect"

export { EventStreamRejectedError, EventStreamTerminatedError } from "./event-errors.ts"

export class NeedsAuthError extends Schema.TaggedError<NeedsAuthError>()("MCP.NeedsAuthError", {
  server: Schema.String,
  message: Schema.String,
  requiredScope: Schema.optional(Schema.String),
}) {}

export class ConnectError extends Schema.TaggedError<ConnectError>()("MCP.ConnectError", {
  server: Schema.String,
  message: Schema.String,
  answered: Schema.optional(Schema.Boolean),
}) {}

export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()("MCP.SessionExpiredError", {
  server: Schema.String,
}) {
  override get message() {
    return `MCP server session expired: ${this.server}`
  }
}

export class SecretResolutionError extends Schema.TaggedError<SecretResolutionError>()("MCP.SecretResolutionError", {
  context: Schema.String,
  message: Schema.String,
}) {}

export class VaultError extends Schema.TaggedError<VaultError>()("MCP.VaultError", {
  operation: Schema.Literals(["read", "write", "remove", "unlock"]),
  message: Schema.String,
}) {}

export class OAuthFlowError extends Schema.TaggedError<OAuthFlowError>()("MCP.OAuthFlowError", {
  server: Schema.String,
  message: Schema.String,
}) {}
