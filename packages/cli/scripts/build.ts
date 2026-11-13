const [outfile = "dist/vibest", target] = process.argv.slice(2)
const args = [
  "build",
  "--compile",
  "./src/main.ts",
  "--outfile",
  outfile,
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
  ...(target ? ["--target", target] : []),
]
const { exitCode } = Bun.spawnSync(["bun", ...args], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(exitCode)
