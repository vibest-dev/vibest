import { Schema } from "effect"

import { Event } from "./event.ts"
import { EventMessage, ServerName, Status } from "./mcp.ts"

export * as McpEvent from "./mcp-event.ts"

export const StatusChanged = Event.ephemeral({
  type: "mcp.status.changed",
  schema: {
    server: ServerName,
    status: Status,
  },
})

export const ToolsChanged = Event.ephemeral({
  type: "mcp.tools.changed",
  schema: {
    server: ServerName,
  },
})

export const ResourcesChanged = Event.ephemeral({
  type: "mcp.resources.changed",
  schema: {
    server: ServerName,
  },
})

export const EventReceived = Event.ephemeral({
  type: "mcp.event.received",
  schema: {
    server: ServerName,
    eventName: Schema.String,
    message: EventMessage,
  },
})
