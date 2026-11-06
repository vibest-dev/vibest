import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const root = path.resolve(import.meta.dirname, "../../..")
const skills = path.join(root, "packages/skills")

const skillFiles = () =>
  fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")))
    .map((entry) => path.join(skills, entry.name, "SKILL.md"))
    .sort()

const vibestCommands = (line: string) => {
  const spans = [...line.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((span) => span.startsWith("vibest "))
  const bare = line.trim()
  if (bare.startsWith("vibest ")) spans.push(bare)
  return spans
}

describe("builtin skills: the invocations they print", () => {
  it("no skill uses the removed --access, and a session later vibest send-ed was not started with --archive-on-completion", () => {
    const errors: Array<string> = []
    for (const file of skillFiles()) {
      const rel = path.relative(root, file)
      const text = fs.readFileSync(file, "utf8")
      if (/--archive(?!-on-completion)/.test(text)) errors.push(`${rel}: bare --archive`)
      let archive: boolean | undefined
      const started = new Map<string, boolean>()
      const lines = text.split("\n")
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? ""
        const at = `${rel}:${index + 1}`
        if (line.includes("--access")) errors.push(`${at}: --access`)
        for (const command of vibestCommands(line)) {
          if (command.startsWith("vibest run ")) archive = /(?:^|\s)--archive-on-completion(?:\s|$)/.test(command)
          const send = /^vibest send\s+(<[^>]+>)/.exec(command)
          if (!send?.[1]) continue
          const flag = started.get(send[1])
          if (flag === undefined) errors.push(`${at}: vibest send ${send[1]} was not started in this skill`)
          else if (flag) errors.push(`${at}: vibest send ${send[1]} was started with --archive-on-completion`)
        }
        const named = /Its id is (<[^>]+>)\./.exec(line)
        if (named?.[1]) {
          if (archive === undefined) errors.push(`${at}: Its id is before a vibest run`)
          else started.set(named[1], archive)
        }
      }
    }
    assert.deepStrictEqual(errors, [])
  })
})
