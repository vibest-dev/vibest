import fs from "node:fs/promises"
import path from "node:path"

type PluginEntry = string | { readonly package: string; readonly options?: Record<string, number> }

export const configurePlugins = async (
  w: { readonly vibestHome: string },
  change: (plugins: Array<PluginEntry>) => Array<PluginEntry>,
) => {
  const file = path.join(w.vibestHome, "vibest.json")
  const config = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { plugins?: Array<PluginEntry> }
  await fs.writeFile(file, JSON.stringify({ ...config, plugins: change(config.plugins ?? []) }))
}

export const useAgyBinary = async (w: { readonly vibestHome: string }, binary: string) => {
  if (binary === "agy") return
  const dir = path.join(w.vibestHome, "agy-binary")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "index.js"),
    `import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({
  id: "agy-binary",
  effect: (ctx) => ctx.harness.transform((editor) => editor.update("agy", (definition) => { definition.binary = ${JSON.stringify(binary)} })).pipe(Effect.asVoid),
})
`,
  )
  await configurePlugins(w, (existing) => [...existing, dir])
}
