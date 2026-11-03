// The production build: `bun run build` in apps/vibest. The arguments live in packages/core/src/build-flags.ts, where a test checks them.
// `bun scripts/build.ts <outfile> <target>` builds elsewhere or for another platform, e.g. a platform package's binary.
import { buildArgs } from "@vibest/core/build-flags"

const [outfile = "dist/vibest", target] = process.argv.slice(2)
const args = [...buildArgs(outfile), ...(target ? ["--target", target] : [])]
const { exitCode } = Bun.spawnSync(["bun", ...args], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(exitCode)
