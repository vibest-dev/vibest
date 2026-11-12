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
