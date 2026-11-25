import { Schema } from "effect"

export const Blocker = Schema.Struct({ id: Schema.String, reason: Schema.String })

export type Blocker = typeof Blocker.Type

export class ProtocolRejected extends Schema.TaggedError<ProtocolRejected>()(
  "ProtocolRejected",
  {
    protocol: Schema.Number,
    version: Schema.String,
    message: Schema.String,
    action: Schema.String,
    method: Schema.String,
    callerProtocol: Schema.NullOr(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class InvalidCaller extends Schema.TaggedError<InvalidCaller>()(
  "InvalidCaller",
  {
    method: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    method: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class DaemonStopping extends Schema.TaggedError<DaemonStopping>()(
  "DaemonStopping",
  { method: Schema.String },
  { httpApiStatus: 503 },
) {
  override get message() {
    return `vibestd is stopping to be replaced; ${this.method} was not run and nothing was recorded. Run it again once vibestd is back (vibest status)`
  }
}

export class DaemonBusy extends Schema.TaggedError<DaemonBusy>()(
  "DaemonBusy",
  { blockers: Schema.Array(Blocker) },
  { httpApiStatus: 409 },
) {
  override get message() {
    return ["vibestd was not stopped; still in use by:", ...this.blockers.map((b) => `  ${b.id}: ${b.reason}`)].join(
      "\n",
    )
  }
}

export class WrongInstance extends Schema.TaggedError<WrongInstance>()(
  "WrongInstance",
  {
    expected: Schema.String,
    actual: Schema.NullOr(Schema.String),
  },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `vibestd instance ${this.actual ?? "unknown"} answers, not ${this.expected}; nothing was stopped`
  }
}

export class WatchLagged extends Schema.TaggedError<WatchLagged>()(
  "WatchLagged",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class UnknownError extends Schema.TaggedError<UnknownError>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  },
  { httpApiStatus: 500 },
) {}
