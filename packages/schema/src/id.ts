import { Effect, Hash } from "effect"

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

export const idFrom = (seed: string): string => {
  const hex = [0, 1, 2, 3].map((salt) => (Hash.string(`${salt}\n${seed}`) >>> 0).toString(16).padStart(8, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
