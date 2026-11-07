import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { userFilesRead } from "../world/shadow.ts"
import { historyFiles } from "../world/user-env.ts"

const contentHash = async (file: string, keys: ReadonlyArray<string> | undefined) => {
  const bytes = await fs.readFile(file).catch(() => undefined)
  if (bytes === undefined) return "missing"
  const hashed =
    keys === undefined
      ? bytes
      : JSON.stringify(keys.map((k) => [k, (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>)[k]]))
  return crypto.createHash("sha256").update(hashed).digest("hex")
}

export const userFileHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      userFilesRead.map(async ({ file, keys }) => [
        keys === undefined ? file : `${file} (${keys.join(", ")})`,
        await contentHash(file, keys),
      ]),
    ),
  ) as Record<string, string>

export const historyNaming = async (worlds: ReadonlyArray<string>, files = historyFiles()) =>
  (
    await Promise.all(
      files.map(async (file) => {
        const text = await fs.readFile(file, "latin1").catch(() => "")
        return worlds.some((w) => text.includes(path.basename(w))) ? [file] : []
      }),
    )
  ).flat()

export const changedUserFiles = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).filter((file) => before[file] !== after[file])

export const herdrSessionsLeft = async (prefix: string) =>
  (await fs.readdir(path.join(os.homedir(), ".config", "herdr", "sessions")).catch(() => [] as Array<string>)).filter(
    (name) => name === prefix || name.startsWith(`${prefix}-`),
  )
