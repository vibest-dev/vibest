import { Plugin } from "@vibest/plugin/effect"
import { Cause, Context, Effect, Stream } from "effect"

export interface ArchiveOnIdleShape {
  readonly optedIn: (id: string) => Effect.Effect<boolean>
  readonly consider: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  readonly parties: (sessionId: string, inbox: number) => Effect.Effect<ReadonlyArray<string>>
  readonly localCreator: (sessionId: string) => Effect.Effect<string | undefined>
}

export class ArchiveOnIdle extends Context.Service<ArchiveOnIdle, ArchiveOnIdleShape>()(
  "vibest/builtin/ArchiveOnIdle",
) {}

const opted = (deps: ArchiveOnIdleShape, ids: ReadonlyArray<string>) =>
  Effect.forEach(ids, (id) => deps.optedIn(id).pipe(Effect.map((yes) => (yes ? id : undefined)))).pipe(
    Effect.map((checked) => checked.filter((id): id is string => id !== undefined)),
    Effect.flatMap((ids) => (ids.length === 0 ? Effect.void : deps.consider(ids))),
  )

export const archiveOnIdlePlugin = Effect.map(ArchiveOnIdle, (deps) =>
  Plugin.define({
    id: "archive-on-idle",
    effect: (ctx) =>
      Effect.gen(function* () {
        const facts = ctx.event.subscribe({
          types: ["execution.ended", "inbox.moved", "session.ended"],
        })
        yield* Stream.runForEach(facts, (event) => {
          const id = event.sessionId
          const act =
            id === undefined
              ? Effect.void
              : event.type === "execution.ended"
                ? event.data.outcome === "completed"
                  ? opted(deps, [id])
                  : Effect.void
                : event.type === "inbox.moved"
                  ? event.data.to === "pending" || event.data.to === "delivering"
                    ? Effect.void
                    : deps.parties(id, event.data.inbox).pipe(Effect.flatMap((ids) => opted(deps, ids)))
                  : event.type === "session.ended"
                    ? deps
                        .localCreator(id)
                        .pipe(
                          Effect.flatMap((creator) => (creator === undefined ? Effect.void : opted(deps, [creator]))),
                        )
                    : Effect.void
          return act.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`archive-on-idle ${event.type}`, cause),
            ),
          )
        }).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
      }).pipe(Effect.asVoid),
  }),
)
