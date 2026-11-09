import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { Effect } from "effect"

import { claude } from "./claude.ts"
import { cursor } from "./cursor.ts"
import { pi } from "./pi.ts"

const harnessPlugin = (definition: Harness.HarnessDefinition) =>
  Plugin.define({
    id: `harness-${definition.id}`,
    effect: (ctx) => ctx.harness.transform((editor) => editor.add(definition)).pipe(Effect.asVoid),
  })

export const piPlugin = harnessPlugin(pi)
export const claudePlugin = harnessPlugin(claude)
export const cursorPlugin = harnessPlugin(cursor)

export { claude, cursor, pi }
