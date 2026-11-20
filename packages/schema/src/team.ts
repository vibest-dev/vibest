import { Schema } from "effect"

import { AgentStatus } from "./session.ts"

export const TEAM_NAME = /^[a-z][a-z0-9-]{0,31}$/

export const TeamName = Schema.String.check(Schema.isPattern(TEAM_NAME))

export const TeamMember = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  name: Schema.String,
  status: AgentStatus,
  startedBy: Schema.NullOr(Schema.String),
})
