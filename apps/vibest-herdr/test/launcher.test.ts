import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// bin/vibest.cjs, the npm entry point: finds the platform package's binary, passes arguments, stdio and the exit status through.
import { assert, it } from "@effect/vitest"

const launcher = path.join(import.meta.dirname, "..", "bin", "vibest.cjs")

it("bin/vibest.cjs runs @vibest/cli-<platform>-<arch>/bin/vibest with the arguments and exits with its status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-launcher-"))
  try {
    const cli = path.join(root, "node_modules", "@vibest", "cli", "bin")
    const binary = path.join(
      root,
      "node_modules",
      "@vibest",
      `cli-${process.platform}-${process.arch}`,
      "bin",
      "vibest",
    )
    await fs.mkdir(cli, { recursive: true })
    await fs.copyFile(launcher, path.join(cli, "vibest.cjs"))
    await fs.writeFile(path.join(cli, "..", "package.json"), JSON.stringify({ version: "0.0.0-test" }))
    // pnpm's bin shims export NODE_PATH (its hoisted store, which links the workspace's real platform package): drop it.
    const run = () =>
      childProcess.spawnSync("node", [path.join(cli, "vibest.cjs"), "a b", "--x"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      })

    // The platform package is not installed.
    const missing = run()
    assert.strictEqual(missing.status, 1)
    assert.include(missing.stderr, `vibest: no binary for ${process.platform}-${process.arch}`)
    assert.include(
      missing.stderr,
      `install it with: npm install -g @vibest/cli-${process.platform}-${process.arch}@0.0.0-test`,
    )

    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.writeFile(binary, `#!/bin/sh\nprintf '%s|' "$@"\nexit 7\n`, { mode: 0o755 })
    const ok = run()
    assert.strictEqual(ok.stdout, "a b|--x|")
    assert.strictEqual(ok.status, 7)

    await fs.writeFile(binary, `#!/bin/sh\nkill -TERM $$\n`)
    assert.strictEqual(run().signal, "SIGTERM")
    // Node ignores SIGPIPE, so the launcher exits as a shell would report it.
    await fs.writeFile(binary, `#!/bin/sh\nkill -PIPE $$\n`)
    assert.strictEqual(run().status, 128 + os.constants.signals.SIGPIPE)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
