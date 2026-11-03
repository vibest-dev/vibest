// Agents whose harness vibestd is restarting in place (`vibest update`, restart.ts): marked before the SIGTERM, cleared
// once the new harness is back or the restart gave up. Memory only: a vibestd that stopped mid-restart leaves no mark,
// so the next one starts with none (docs/design/schema.md, Memory).
import { Context, Effect, Layer } from "effect"

const make = Effect.sync(() => {
  const ids = new Set<string>()
  return {
    /** Whether session `id`'s harness is being restarted right now. */
    has: (id: string) => ids.has(id),
    mark: (id: string) =>
      Effect.sync(() => {
        ids.add(id)
      }),
    clear: (id: string) =>
      Effect.sync(() => {
        ids.delete(id)
      }),
  }
})

/** One per vibestd, shared by the restart, Sessions, Inbox and the RPC server. */
export class Restarting extends Context.Service<Restarting, Effect.Success<typeof make>>()("vibest/Restarting") {
  static readonly layer = Layer.effect(Restarting, make)
}
