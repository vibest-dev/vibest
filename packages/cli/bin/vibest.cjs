#!/usr/bin/env node
const childProcess = require("node:child_process")
const os = require("node:os")
const path = require("node:path")

const target = `${process.platform}-${process.arch}`
let binary
try {
  binary = require.resolve(`@vibest/cli-${target}/bin/vibest`)
} catch {
  const pkg = `@vibest/cli-${target}@${require("../package.json").version}`
  const prefix = /^(.+)\/lib\/node_modules\/@vibest\/cli\/bin$/.exec(__dirname)
  const install = __dirname.includes("/.bun/")
    ? `bun add -g ${pkg}`
    : prefix
      ? `npm install -g --prefix ${prefix[1]} ${pkg}`
      : `npm install -g ${pkg}`
  console.error(`vibest: no binary for ${target}; install it with: ${install}`)
  process.exit(1)
}

const env = { ...process.env, VIBEST_HARNESSES: path.join(__dirname, "..", "harnesses") }
const child = childProcess.spawn(binary, process.argv.slice(2), { stdio: "inherit", env })
process.on("SIGINT", () => {})
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("error", (error) => {
  console.error(`vibest: cannot run ${binary}: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1)
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
  process.exit(128 + os.constants.signals[signal])
})
