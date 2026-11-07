import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { loginEnv } from "../world/user-env.ts"
import { shared } from "./pool.ts"

const dir = path.join(shared, "cache")
const src = path.resolve(import.meta.dirname, "..")
const TOOLS = [
  ["herdr", "--version"],
  ["hc", "--version"],
  ["claude", "--version"],
  ["pi", "--version"],
  ["cursor-agent", "--version"],
  ["bun", "--version"],
  ["node", "--version"],
]

const sha = (...parts: ReadonlyArray<string | Uint8Array>) => {
  const h = crypto.createHash("sha256")
  for (const p of parts) h.update(p).update("\0")
  return h.digest("hex")
}

const tree = async (root: string, skip: (rel: string) => boolean = () => false) => {
  const files = (await fs.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .filter((rel) => !skip(rel))
    .sort()
  return sha(...(await Promise.all(files.map(async (rel) => sha(rel, await fs.readFile(path.join(root, rel)))))))
}

const version = async (argv: ReadonlyArray<string>, env: Record<string, string>) => {
  const bin = Bun.which(argv[0]!, { PATH: env.PATH ?? "" })
  if (bin === null) return `${argv[0]} missing`
  const p = Bun.spawn([bin, ...argv.slice(1)], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return `${argv[0]} ${out.trim()}`
}

const scenario = async (file: string, seen: Set<string>): Promise<string> => {
  seen.add(file)
  const text = await fs.readFile(path.join(src, "scenarios", file), "utf8")
  const imported = [...text.matchAll(/from "\.\/([\w-]+\.ts)"/g)].map((m) => m[1]!).filter((f) => !seen.has(f))
  return sha(text, ...(await Promise.all(imported.map((f) => scenario(f, seen)))))
}

const stablePath = (p: string) => p.replace(/fnm_multishells\/[^/:]+/g, "fnm_multishells")

export const cacheKeys = async (o: {
  readonly binary: string
  readonly harnesses: string
  readonly method: string
  readonly userFiles: Record<string, string>
}) => {
  const env = await loginEnv()
  const [binary, harnesses, runner, versions] = await Promise.all([
    Bun.file(o.binary)
      .arrayBuffer()
      .then((b) => sha(new Uint8Array(b))),
    tree(o.harnesses),
    tree(src, (rel) => rel.startsWith("scenarios/")),
    Promise.all(TOOLS.map((argv) => version(argv, env))),
  ])
  const base = sha(
    binary,
    harnesses,
    runner,
    ...versions,
    o.method,
    JSON.stringify(o.userFiles),
    stablePath(env.PATH ?? ""),
  )
  const areas = new Map<string, Promise<string>>()
  return (area: string, id: string) => {
    if (!areas.has(area)) areas.set(area, scenario(`${area}.ts`, new Set()))
    return areas.get(area)!.then((file) => sha(base, file, id))
  }
}

export const cached = (key: string) =>
  fs.stat(path.join(dir, key)).then(
    () => true,
    () => false,
  )

export const remember = async (key: string, id: string) => {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, key), `${id}\n`)
}
