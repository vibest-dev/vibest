#!/usr/bin/env node
// npm entry point: runs the compiled vibest binary from the platform package, @vibest/cli-<platform>-<arch>.
const childProcess = require("node:child_process")
const os = require("node:os")
const path = require("node:path")

const target = `${process.platform}-${process.arch}`
let binary
try {
  binary = require.resolve(`@vibest/cli-${target}/bin/vibest`)
} catch {
  console.error(`vibest: no binary for ${target} (reinstall @vibest/cli without --omit=optional)`)
  process.exit(1)
}

// vibest's plugin for each harness ships in this package (scripts/build-harnesses.ts); the binary passes it to each harness it starts.
const env = { ...process.env, VIBEST_HARNESSES: path.join(__dirname, "..", "harnesses") }
const child = childProcess.spawn(binary, process.argv.slice(2), { stdio: "inherit", env })
// The terminal already delivers Ctrl-C to the child (same process group); forwarding it as well would turn one Ctrl-C into two.
process.on("SIGINT", () => {})
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("error", (error) => {
  console.error(`vibest: cannot run ${binary}: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1)
  // Die of the same signal, so the caller sees what the binary saw; Node ignores some (SIGPIPE), so exit as a shell reports it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
  process.exit(128 + os.constants.signals[signal])
})
