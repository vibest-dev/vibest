import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { Effect } from "effect"

export const harnessPlugin = (definition: Harness.HarnessDefinition) =>
  Plugin.define({
    id: `harness-${definition.id}`,
    effect: (ctx) => ctx.harness.transform((editor) => editor.add(definition)).pipe(Effect.asVoid),
  })
