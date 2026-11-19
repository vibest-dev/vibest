import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

const script = path.join(import.meta.dirname, "..", "install.sh")

const target = `${process.platform}-${process.arch}`

it("install.sh keeps the new version, the one before it, and a version directory a running process uses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-install-"))
  const share = path.join(root, "share")
  const releaseArchiveReporting999 = path.join(root, "pkg")
  fs.mkdirSync(path.join(releaseArchiveReporting999, "bin"), { recursive: true })
  fs.writeFileSync(path.join(releaseArchiveReporting999, "bin", "vibest"), "#!/bin/sh\necho 'vibest v9.9.9'\n", {
    mode: 0o755,
  })
  const release = path.join(root, "release")
  fs.mkdirSync(release)
  childProcess.spawnSync("tar", [
    "-czf",
    path.join(release, `vibest-${target}.tar.gz`),
    "-C",
    releaseArchiveReporting999,
    "bin",
  ])

  for (const v of ["1.0.0", "2.0.0", "3.0.0"]) fs.mkdirSync(path.join(share, "versions", v, "bin"), { recursive: true })
  fs.writeFileSync(path.join(share, "current"), "3.0.0\n")

  const pluginDirUser = childProcess.spawn(
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
    pluginDirUser.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const releasesOn = (root: string, latest: string, listed: ReadonlyArray<string>) => {
  const releases = path.join(root, "releases")
  fs.mkdirSync(path.join(releases, "latest", "download"), { recursive: true })
  fs.writeFileSync(path.join(releases, "latest", "download", "version"), `${latest}\n`)
  fs.writeFileSync(
    `${releases}.atom`,
    listed.map((v) => `<link href="https://github.com/vibest-dev/vibest/releases/tag/v${v}"/>`).join("\n"),
  )

  for (const v of listed) {
    const pkg = path.join(root, "pkg", v)
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
    fs.writeFileSync(path.join(pkg, "bin", "vibest"), `#!/bin/sh\necho 'vibest v${v}'\n`, { mode: 0o755 })
    const download = path.join(releases, "download", `v${v}`)
    fs.mkdirSync(download, { recursive: true })
    childProcess.spawnSync("tar", ["-czf", path.join(download, `vibest-${target}.tar.gz`), "-C", pkg, "bin"])
  }

  return (args: ReadonlyArray<string>) => {
    const share = path.join(root, `share${args.join("")}`)

    const out = childProcess.spawnSync("sh", [script, ...args], {
      env: {
        ...process.env,
        VIBEST_DOWNLOAD_URL: "",
        VIBEST_RELEASES_URL: `file://${releases}`,
        VIBEST_INSTALL: share,
        VIBEST_BIN: path.join(root, "bin"),
      },
      encoding: "utf8",
    })

    const current = fs.existsSync(path.join(share, "current"))
      ? fs.readFileSync(path.join(share, "current"), "utf8").trim()
      : undefined

    return { status: out.status, stderr: out.stderr, current }
  }
}

it("install.sh installs the newest stable release, and with --beta the newest release of either channel", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-install-"))

  try {
    const install = releasesOn(root, "0.2.0", ["0.3.0-beta.1", "0.2.0", "0.2.0-beta.9", "0.1.0", "0.3.0-beta.10"])
    assert.deepInclude(install([]), { status: 0, current: "0.2.0" })
    assert.deepInclude(install(["--beta"]), { status: 0, current: "0.3.0-beta.10" })
    const stableNewest = releasesOn(path.join(root, "b"), "1.0.0", ["1.0.0", "1.0.0-beta.3"])
    assert.deepInclude(stableNewest(["--beta"]), { status: 0, current: "1.0.0" })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it("install.sh refuses to install a beta when there is no stable release, naming --beta", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-install-"))

  try {
    const r = releasesOn(root, "0.0.1-beta.19", ["0.0.1-beta.19"])([])
    assert.strictEqual(r.status, 1)
    assert.isUndefined(r.current)
    assert.include(r.stderr, "no stable release yet")
    assert.include(r.stderr, "sh -s -- --beta")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const installOver = (prepare: (share: string) => void) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-install-"))
  const share = path.join(root, "share")
  const bin = path.join(root, "bin")
  const pkg = path.join(root, "pkg")
  const release = path.join(root, "release")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.writeFileSync(path.join(pkg, "bin", "vibest"), "#!/bin/sh\necho 'vibest v9.9.9'\n", { mode: 0o755 })
  fs.mkdirSync(release)
  childProcess.spawnSync("tar", ["-czf", path.join(release, `vibest-${target}.tar.gz`), "-C", pkg, "bin"])
  const old = path.join(share, "versions", "1.0.0", "bin", "vibest")
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.writeFileSync(old, "#!/bin/sh\necho 'vibest v1.0.0'\n", { mode: 0o755 })
  fs.mkdirSync(bin)
  fs.symlinkSync(old, path.join(bin, "vibest"))
  fs.writeFileSync(path.join(share, "current"), "1.0.0\n")
  prepare(share)

  try {
    const out = childProcess.spawnSync("sh", [script], {
      env: { ...process.env, VIBEST_DOWNLOAD_URL: `file://${release}`, VIBEST_INSTALL: share, VIBEST_BIN: bin },
      encoding: "utf8",
    })

    const runs = childProcess.spawnSync(path.join(bin, "vibest"), ["--version"], { encoding: "utf8" }).stdout.trim()

    return {
      status: out.status,
      stderr: out.stderr,
      runs,
      current: fs.readFileSync(path.join(share, "current"), "utf8"),
    }
  } finally {
    fs.chmodSync(path.join(share, "current"), 0o644)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

it("install.sh refuses an existing version directory that differs from the download and leaves the old install running", () => {
  const r = installOver((share) => fs.mkdirSync(path.join(share, "versions", "9.9.9", "bin"), { recursive: true }))

  assert.strictEqual(r.status, 1)
  assert.include(r.stderr, "differs from the 9.9.9 download")
  assert.deepInclude(r, { runs: "vibest v1.0.0", current: "1.0.0\n" })
})

it("install.sh that cannot record the new version leaves the old install running and recorded", () => {
  const r = installOver((share) => fs.chmodSync(path.join(share, "current"), 0o444))

  assert.notStrictEqual(r.status, 0)
  assert.deepInclude(r, { runs: "vibest v1.0.0", current: "1.0.0\n" })
})

it("install.sh installs over an existing identical version directory a harness wrote into", () => {
  const r = installOver((share) => {
    const dir = path.join(share, "versions", "9.9.9")
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
    fs.writeFileSync(path.join(dir, "bin", "vibest"), "#!/bin/sh\necho 'vibest v9.9.9'\n", { mode: 0o755 })
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}")
  })

  assert.strictEqual(r.status, 0, r.stderr)
  assert.deepInclude(r, { runs: "vibest v9.9.9", current: "9.9.9\n" })
})
