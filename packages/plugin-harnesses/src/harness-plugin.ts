import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

type SubscriptionResult = Effect.Success<ReturnType<NonNullable<Harness.HarnessDefinition["subscription"]>>>
type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export const harnessPlugin = (
  definition: Harness.HarnessDefinition,
  subscription?: (home: string) => Effect.Effect<SubscriptionResult, never, Services>,
) =>
  Effect.map(Effect.context<Services>(), (services) =>
    Plugin.define({
      id: `harness-${definition.id}`,
      effect: (ctx) =>
        ctx.harness
          .transform((editor) =>
            editor.add(
              subscription
                ? { ...definition, subscription: (home) => subscription(home).pipe(Effect.provideContext(services)) }
                : definition,
            ),
          )
          .pipe(Effect.asVoid),
    }),
  )
