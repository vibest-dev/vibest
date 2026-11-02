// Publish the platform packages, then @vibest/cli, under the npm `beta` tag.
// Safe to rerun: a version already on npm is skipped, and a failed upload is
// retried. One at a time, so npm asks for 2FA once and its 5-minute cache
// covers the rest. pnpm packs (it resolves workspace: and catalog: versions);
// npm uploads, since pnpm's 2FA prompt prints a QR code.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const dirs = [
  ...fs
    .readdirSync(path.join(root, "packages"))
    .filter((name) => name.startsWith("cli-"))
    .map((name) => path.join(root, "packages", name)),
  path.join(root, "apps/vibest-herdr"),
]

// stderr is shown as it arrives (npm prints its 2FA link there) and kept for the checks below.
const run = async (cmd: string[], cwd = root, env: Record<string, string> = {}) => {
  const child = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdin: "inherit", stdout: "inherit", stderr: "pipe" })
  let stderr = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stderr) {
    process.stderr.write(chunk)
    stderr += decoder.decode(chunk, { stream: true })
  }
  return { exitCode: await child.exited, stderr }
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-publish-"))

const already = (spec: string) => {
  const r = Bun.spawnSync(["npm", "view", spec, "version"], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0 && r.stdout.toString().trim() !== ""
}

for (const dir of dirs) {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  const spec = `${name}@${version}`
  if (already(spec)) {
    console.log(`skip ${spec}: already on npm`)
    continue
  }
  // The build already ran (turbo); ignore-scripts skips prepack's rebuild.
  const tarball = path.join(out, `${name.replace("/", "-")}.tgz`)
  const packed = await run(["pnpm", "pack", "--silent", "--out", tarball], dir, { npm_config_ignore_scripts: "true" })
  if (packed.exitCode !== 0) {
    console.error(`${spec} could not be packed`)
    process.exit(1)
  }
  for (let attempt = 1; ; attempt++) {
    const r = await run(["npm", "publish", tarball, "--tag", "beta", "--access", "public"])
    const err = r.stderr
    if (r.exitCode === 0) break
    // npm's read side can lag a fresh publish; the write side knows.
    if (/previously published|cannot publish over/i.test(err)) {
      console.log(`skip ${spec}: already on npm`)
      break
    }
    if (attempt === 3) {
      console.error(`${spec} failed after ${attempt} attempts; rerun pnpm publish:beta to continue`)
      process.exit(1)
    }
    console.error(`${spec} failed; retrying (${attempt}/3)`)
  }
}
