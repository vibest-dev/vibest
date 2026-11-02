// Build the npm artifact in place (prepack), or the same shippable files into <outdir>.
// Writes hooks/register.mjs, src/plugin.ts bundled with the header definition it imports into one import-free ES module,
// and .claude-plugin/plugin.json: src/manifest.json stamped with this package.json's version, which Claude Code uses as
// the plugin's cache version. Both are generated and ignored by Git. With <outdir> it also copies hooks/hooks.json,
// README.md and LICENSE there, giving a complete standalone plugin directory. No src, tests, scripts or type cache.
// Prebuilt JS is this package's npm delivery choice. Claude Code can also load TypeScript hooks modules directly.
import fs from "node:fs"
import path from "node:path"
import url from "node:url"

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>

const version = readJson("package.json").version
if (typeof version !== "string" || version === "") throw new Error("package.json has no version")
const outdir = path.resolve(process.argv[2] ?? root)
const write = (name: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(outdir, name)), { recursive: true })
  fs.writeFileSync(path.join(outdir, name), text)
}

write(".claude-plugin/plugin.json", `${JSON.stringify({ ...readJson("src/manifest.json"), version }, null, 2)}\n`)
if (outdir !== root)
  for (const name of ["hooks/hooks.json", "README.md", "LICENSE"]) write(name, fs.readFileSync(path.join(root, name)))
// Bun writes each module's path relative to the working directory into the bundle; pin it so the bytes don't vary.
process.chdir(root)
const result = await Bun.build({
  entrypoints: [path.join(root, "src/plugin.ts")],
  outdir: path.join(outdir, "hooks"),
  naming: "register.mjs",
  target: "browser",
  format: "esm",
  // Claude Code's `$.plugin` has no version: the module sends this one to vibestd (vibest-plugin-version).
  define: { VIBEST_PLUGIN_VERSION: JSON.stringify(version) },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
