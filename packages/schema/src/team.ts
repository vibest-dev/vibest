import { Schema } from "effect"

import { AgentStatus } from "./session.ts"

export const TeamMember = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  name: Schema.String,
  status: AgentStatus,
  startedBy: Schema.NullOr(Schema.String),
})
