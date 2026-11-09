import { buildArgs } from "@vibest/core/build-flags"

const [outfile = "dist/vibest", target] = process.argv.slice(2)
const args = [...buildArgs(outfile), ...(target ? ["--target", target] : [])]
const { exitCode } = Bun.spawnSync(["bun", ...args], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(exitCode)
