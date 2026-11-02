// Write vibest's plugin for each harness into <outdir>/<harness> (default this package's harnesses/, which npm ships):
// what vibest starts each harness with (`--plugin-dir`, `pi -e`), including its dereferenced `skills/` directory. The
// binary finds it through VIBEST_HARNESSES, which bin/vibest.cjs sets.
import fs from "node:fs"
import path from "node:path"

const app = path.dirname(import.meta.dir)
const outdir = path.resolve(process.argv[2] ?? path.join(app, "harnesses"))
const integration = path.join(app, "../../packages/integration")
fs.rmSync(outdir, { recursive: true, force: true })
for (const harness of ["pi", "claude", "cursor"]) {
  const { exitCode } = Bun.spawnSync(
    ["bun", path.join(integration, harness, "scripts/build.ts"), path.join(outdir, harness)],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  )
  if (exitCode !== 0) process.exit(exitCode)
  const skills = path.join(integration, harness, harness === "pi" ? "src/skills" : "skills")
  const names = fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`no skills in ${skills}`)
  for (const name of names) {
    fs.cpSync(path.join(skills, name), path.join(outdir, harness, "skills", name), {
      recursive: true,
      dereference: true,
    })
  }
}
