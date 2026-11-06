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
process.chdir(root)
const result = await Bun.build({
  entrypoints: [path.join(root, "src/plugin.ts")],
  outdir: path.join(outdir, "hooks"),
  naming: "register.mjs",
  target: "browser",
  format: "esm",
  define: { VIBEST_PLUGIN_VERSION: JSON.stringify(version) },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
