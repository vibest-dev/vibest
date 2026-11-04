// The one id generator (docs/design/schema.md, Ids): every id vibest makes is a UUIDv4, shown by its first 8 characters.
import { Effect } from "effect"

/** A UUIDv4 as `newId` makes it: lowercase, 36 characters. */
export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The id as people read it: its first 8 characters. */
export const shortId = (id: string) => id.slice(0, 8)

/** A new UUIDv4, with no uniqueness check beyond the UUID's own (use `newId` for an id shown by its first 8). */
export const randomId = (): string =>
  // The Web Crypto global (Node, Bun and browsers); this package has no platform types.
  (globalThis as unknown as { readonly crypto: { readonly randomUUID: () => string } }).crypto.randomUUID()

/**
 * A new UUIDv4. When `taken` says its first 8 characters are already used, another is drawn: the UUID is globally
 * unique, and the retry keeps an id shown by its first 8 characters unique where `taken` looks.
 */
export const newId = <E = never, R = never>(
  taken: (short: string) => Effect.Effect<boolean, E, R> = () => Effect.succeed(false),
) =>
  Effect.sync(randomId).pipe(
    Effect.flatMap((id) => taken(shortId(id)).pipe(Effect.map((used) => (used ? undefined : id)))),
    Effect.repeat({ until: (id): id is string => id !== undefined }),
    Effect.map((id) => id!),
  )
