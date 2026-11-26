import { Schema } from "effect"

export class EventStreamRejectedError extends Schema.TaggedError<EventStreamRejectedError>()(
  "MCP.EventStreamRejectedError",
  {
    server: Schema.String,
    code: Schema.Number,
    message: Schema.String,
  },
) {}

export class EventStreamTerminatedError extends Schema.TaggedError<EventStreamTerminatedError>()(
  "MCP.EventStreamTerminatedError",
  {
    server: Schema.String,
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optional(Schema.Json),
  },
) {}
