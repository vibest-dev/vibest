import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const userFiles = [".claude/settings.json", ".cursor/hooks.json", ".pi/agent/settings.json"].map((p) =>
  path.join(os.homedir(), p),
)

export const userFileHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      userFiles.map(async (file) => [
        file,
        await fs.readFile(file).then(
          (bytes) => crypto.createHash("sha256").update(bytes).digest("hex"),
          () => "missing",
        ),
      ]),
    ),
  ) as Record<string, string>

export const changedUserFiles = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).filter((file) => before[file] !== after[file])

export const herdrSessionsLeft = async (prefix: string) =>
  (await fs.readdir(path.join(os.homedir(), ".config", "herdr", "sessions")).catch(() => [] as Array<string>)).filter(
    (name) => name === prefix || name.startsWith(`${prefix}-`),
  )
