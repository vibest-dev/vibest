import { Effect, Schema } from "effect"

export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const RequestId = Schema.String.check(Schema.isUUID(4))

export const ProjectId = Schema.String.check(Schema.isUUID(4))

export type ProjectId = typeof ProjectId.Type

export const SessionId = Schema.String.check(Schema.isUUID(4))

export type SessionId = typeof SessionId.Type

export const MachineName = Schema.NonEmptyString

export type MachineName = typeof MachineName.Type

export const shortId = (id: string) => id.slice(0, 8)

export const sessionLabel = (session: { readonly id: string; readonly name: string }) =>
  session.name === "" ? shortId(session.id) : `${shortId(session.id)} (${session.name})`

export const entryLabel = (directory: string) => {
  const name = directory
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1)

  return name ? `Vibest/${name}` : "Vibest"
}

declare const crypto: { readonly randomUUID: () => string }

export const randomId = (): string => crypto.randomUUID()

export const newId = <E = never, R = never>(
  taken: (short: string) => Effect.Effect<boolean, E, R> = () => Effect.succeed(false),
) =>
  Effect.sync(randomId).pipe(
    Effect.flatMap((id) => taken(shortId(id)).pipe(Effect.map((used) => (used ? undefined : id)))),
    Effect.repeat({ until: (id): id is string => id !== undefined }),
    Effect.map((id) => id!),
  )
