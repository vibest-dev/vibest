import pkg from "../package.json" with { type: "json" }

const [outfile = "dist/vibest", target] = process.argv.slice(2)
const args = [
  "build",
  "--compile",
  "./src/main.ts",
  "--outfile",
  outfile,
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
  "--define",
  `VIBEST_VERSION=${JSON.stringify(pkg.version)}`,
  ...(target ? ["--target", target] : []),
]
const { exitCode } = Bun.spawnSync(["bun", ...args], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(exitCode)
