import path from "node:path"

const app = path.dirname(import.meta.dir)
const outdir = path.resolve(process.argv[2] ?? path.join(app, "plugins"))

for (const plugin of ["silent-execution"]) {
  const built = await Bun.build({
    entrypoints: [path.join(app, `../builtins/src/${plugin}.ts`)],
    outdir: path.join(outdir, plugin),
    naming: "index.js",
    target: "bun",
    external: ["effect", "effect/*", "@vibest/plugin", "@vibest/plugin/*"],
  })

  if (!built.success) {
    for (const log of built.logs) console.error(log)
    process.exit(1)
  }
}
