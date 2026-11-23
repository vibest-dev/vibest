import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repository = path.resolve(import.meta.dirname, "../../..")

const run = async (cwd: string, argv: ReadonlyArray<string>) => {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" })

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0) throw new Error(`${argv.join(" ")} in ${cwd} exited ${code}: ${err}${out}`)
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

export const olderBuild = async (commit: string) => {
  const dir = path.join(os.tmpdir(), `vibest-e2e-build-${commit}`)
  const bin = path.join(dir, "packages/cli/dist/vibest")

  if (await exists(bin)) return bin
  const known = Bun.spawnSync(["git", "cat-file", "-e", `${commit}^{commit}`], { cwd: repository }).exitCode === 0

  if (!known) await run(repository, ["git", "fetch", "-q", "--depth", "1", "origin", commit])
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-e2e-building-"))

  try {
    await run(repository, ["sh", "-c", 'git archive "$1" | tar -x -C "$2"', "sh", commit, staging])
    await run(staging, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"])
    await run(staging, ["pnpm", "build"])
    await fs.rename(staging, dir)
  } catch (e) {
    if (!(await exists(bin))) throw e
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }

  return bin
}
