import { Schema } from "effect"

import { Event } from "./event.ts"

export * as ProjectEvent from "./project-event.ts"

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Repository = Schema.Struct({ path: Text, remote: optional(Text) })
const Repositories = Schema.Array(Repository)

const Base = { projectId: Text }
const options = { durable: { aggregate: "projectId", version: 1 } } as const

export const Created = Event.durable({
  type: "project.created",
  ...options,
  schema: {
    ...Base,
    directory: optional(Text),
    repositories: Repositories,
  },
})

export type Created = Event.Payload<typeof Created>

export const Moved = Event.durable({
  type: "project.moved",
  ...options,
  schema: {
    ...Base,
    from: Text,
    to: Text,
    repositories: Repositories,
  },
})

export type Moved = Event.Payload<typeof Moved>

export const RepositoriesChanged = Event.durable({
  type: "project.repositories_changed",
  ...options,
  schema: {
    ...Base,
    repositories: Repositories,
  },
})

export type RepositoriesChanged = Event.Payload<typeof RepositoriesChanged>

export const Public = Event.inventory(Created, Moved, RepositoriesChanged)
