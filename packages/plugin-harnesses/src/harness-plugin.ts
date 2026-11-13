import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { Effect } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

import type { Spawner } from "./subscriptions/index.ts"

export const harnessPlugin = (
  definition: Harness.HarnessDefinition,
  subscription?: (spawner: Spawner) => NonNullable<Harness.HarnessDefinition["subscription"]>,
) =>
  Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (spawner) =>
    Plugin.define({
      id: `harness-${definition.id}`,
      effect: (ctx) =>
        ctx.harness
          .transform((editor) =>
            editor.add(subscription ? { ...definition, subscription: subscription(spawner) } : definition),
          )
          .pipe(Effect.asVoid),
    }),
  )
