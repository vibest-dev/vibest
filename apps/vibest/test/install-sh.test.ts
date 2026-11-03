import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// install.sh's cleanup: it keeps the new version, the one before it, and any version a running process still uses.
import { assert, it } from "@effect/vitest"

const script = path.join(import.meta.dirname, "..", "install.sh")

const target = process.platform === "darwin" ? "darwin-arm64" : "linux-x64"

it("install.sh keeps a version directory a running process uses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-install-"))
  const share = path.join(root, "share")
  // The release archive: a bin/vibest that reports 9.9.9.
  const pkg = path.join(root, "pkg")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.writeFileSync(path.join(pkg, "bin", "vibest"), "#!/bin/sh\necho 'vibest v9.9.9'\n", { mode: 0o755 })
  const release = path.join(root, "release")
  fs.mkdirSync(release)
  childProcess.spawnSync("tar", ["-czf", path.join(release, `vibest-${target}.tar.gz`), "-C", pkg, "bin"])
  for (const v of ["1.0.0", "2.0.0", "3.0.0"]) fs.mkdirSync(path.join(share, "versions", v, "bin"), { recursive: true })
  fs.writeFileSync(path.join(share, "current"), "3.0.0\n")
  // A process that runs from 1.0.0 (as an agent's --plugin-dir names its harness directory).
  const user = childProcess.spawn(
    "sh",
    ["-c", "sleep 30; :", path.join(share, "versions", "1.0.0", "harnesses", "claude")],
    {
      stdio: "ignore",
    },
  )
  try {
    const out = childProcess.spawnSync("sh", [script], {
      env: {
        ...process.env,
        VIBEST_DOWNLOAD_URL: `file://${release}`,
        VIBEST_INSTALL: share,
        VIBEST_BIN: path.join(root, "bin"),
      },
      encoding: "utf8",
    })
    assert.strictEqual(out.status, 0, out.stderr)
    assert.deepStrictEqual(fs.readdirSync(path.join(share, "versions")).sort(), ["1.0.0", "3.0.0", "9.9.9"])
  } finally {
    user.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
