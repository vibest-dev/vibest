import fs from "node:fs/promises"
import path from "node:path"

export const configurePlugins = async (
  w: { readonly vibestHome: string },
  change: (plugins: Array<string>) => Array<string>,
) => {
  const file = path.join(w.vibestHome, "vibest.json")
  const config = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { plugins?: Array<string> }
  await fs.writeFile(file, JSON.stringify({ ...config, plugins: change(config.plugins ?? []) }))
}

export const addCursorPlugin = (w: { readonly vibestHome: string }, harnesses: string) =>
  configurePlugins(w, (plugins) => [...plugins, path.join(harnesses, "cursor", "plugin.js")])

export const addAgyPlugin = async (w: { readonly vibestHome: string }, harnesses: string, binary: string) => {
  const plugins = [path.join(harnesses, "agy", "plugin.js")]
  if (binary !== "agy") {
    const file = path.join(w.vibestHome, "agy-binary.js")
    await fs.writeFile(
      file,
      `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({
  id: "agy-binary",
  effect: (ctx) => ctx.harness.transform((editor) => editor.update("agy", (definition) => { definition.binary = ${JSON.stringify(binary)} })).pipe(Effect.asVoid),
})
`,
    )
    plugins.push(file)
  }
  await configurePlugins(w, (existing) => [...existing, ...plugins])
}
