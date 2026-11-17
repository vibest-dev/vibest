import fs from "node:fs/promises"
import path from "node:path"

import { userPrivateValues } from "./shadow.ts"
import { secretName } from "./user-env.ts"

const secrets = (login: Readonly<Record<string, string>>) => [
  ...(process.env.VIBEST_E2E_ENV ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((pair) => pair.slice(pair.indexOf("=") + 1)),
  ...Object.entries(login)
    .filter(([name, value]) => secretName.test(name) && value.length >= 6)
    .map(([, value]) => value),
]

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const privateValues = await userPrivateValues()

export const privateIn = (text: string, words: ReadonlyArray<string> = privateValues) =>
  words.filter((w) => new RegExp(`(?<![\\w-])${escaped(w)}(?![\\w-])`).test(text))

export const redactWith = (text: string, exact: ReadonlyArray<string>, words: ReadonlyArray<string>) =>
  words.reduce(
    (t, w) => t.replace(new RegExp(`(?<![\\w-])${escaped(w)}(?![\\w-])`, "g"), "<redacted>"),
    exact.reduce((t, value) => (value === "" ? t : t.split(value).join("<redacted>")), text),
  )

export const redactor = (login: Readonly<Record<string, string>>) => (text: string) =>
  redactWith(text, secrets(login), privateValues)

export const copyEvidence = async (
  login: Readonly<Record<string, string>>,
  from: string,
  to: string,
  words: ReadonlyArray<string>,
) => {
  for (const e of await fs.readdir(from, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const source = path.join(e.parentPath, e.name)
    const target = path.join(to, path.relative(from, source))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, redactWith(await fs.readFile(source, "latin1"), secrets(login), words), "latin1")
  }
}
