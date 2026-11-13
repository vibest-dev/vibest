import { Effect } from "effect"

export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const shortId = (id: string) => id.slice(0, 8)

export const randomId = (): string =>
  (globalThis as unknown as { readonly crypto: { readonly randomUUID: () => string } }).crypto.randomUUID()

export const newId = <E = never, R = never>(
  taken: (short: string) => Effect.Effect<boolean, E, R> = () => Effect.succeed(false),
) =>
  Effect.sync(randomId).pipe(
    Effect.flatMap((id) => taken(shortId(id)).pipe(Effect.map((used) => (used ? undefined : id)))),
    Effect.repeat({ until: (id): id is string => id !== undefined }),
    Effect.map((id) => id!),
  )
