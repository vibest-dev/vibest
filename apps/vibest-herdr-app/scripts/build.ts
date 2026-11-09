import path from "node:path"
import url from "node:url"

const MODS = {
  "vibest-sidebar-header": "src/sidebar/header.ts",
  "vibest-sidebar-threads": "src/sidebar/threads/main.ts",
  "vibest-sidebar-footer": "src/sidebar/footer.ts",
  "vibest-topbar": "src/workspace/topbar.ts",
  "vibest-agents": "src/panel/agents/main.ts",
} as const

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
process.chdir(root)
for (const [name, entry] of Object.entries(MODS)) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: `home/mods/${name}`,
    naming: "main.js",
    format: "esm",
    target: "browser",
    external: ["gpui-kit", "gpui-base", "herdr"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}
