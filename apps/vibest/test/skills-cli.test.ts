import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Builtin skills: the invocations they print, and how each harness plugin ships and exposes them.
import { assert, describe, it } from "@effect/vitest"
import { type CoordinatorInput, type LaunchInput, sessionPlugin } from "@vibest/core/harness"
import { BUILTIN as ADAPTERS } from "@vibest/core/harnesses"
import { ConfigProvider, Effect } from "effect"

import * as Platform from "#platform"

import { ARCHIVE_ROOTS } from "../scripts/archive-layout.ts"

const root = path.resolve(import.meta.dirname, "../../..")
const skills = path.join(root, "packages/skills")

const skillFiles = () =>
  fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, "SKILL.md")))
    .map((entry) => path.join(skills, entry.name, "SKILL.md"))
    .sort()

/** A line's `vibest …` commands: a fence line, or each backtick span. */
const commandsOn = (line: string) => {
  const spans = [...line.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((span) => span.startsWith("vibest "))
  const bare = line.trim()
  if (bare.startsWith("vibest ")) spans.push(bare)
  return spans
}

const launch = (pluginDir: string): LaunchInput => ({
  worktree: "/wt",
  projectDir: "/project",
  systemPromptFile: "/rules.md",
  provider: null,
  model: null,
  sessionId: "uuid",
  resume: false,
  pluginDir,
  vibest: ["vibest"],
  env: { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" },
})

const coordinator = (pluginDir: string): CoordinatorInput => ({
  root: "/repo",
  projectDir: "/project",
  systemPromptFile: "/r.md",
  provider: null,
  model: null,
  sessionId: null,
  pluginDir,
  env: { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "c0ffee00-c0ff-4c0f-8c0f-c0ffee00c0ff" },
})

const frontmatterField = (file: string, key: string) =>
  new RegExp(`^${key}:\\s*(.+)\\s*$`, "m").exec(fs.readFileSync(file, "utf8"))?.[1]

describe("builtin skills", () => {
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
        for (const command of commandsOn(line)) {
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
    const delegate = fs.readFileSync(path.join(skills, "delegate/SKILL.md"), "utf8")
    assert.include(delegate, "Archiving keeps the branch, and the worktree whenever it holds unsaved work")
    assert.include(delegate, "Archive a research agent with `vibest archive <id>` once its findings are saved")
    assert.include(delegate, "Keep an agent that changed code until the user asks to remove it")
    assert.notInclude(delegate, "Do not remove sessions on your own")
    assert.deepStrictEqual(errors, [])
  })

  it("each harness plugin ships dereferenced skills from its relative symlink; Pi keeps user skills and gates on the main agent", () => {
    for (const [link, target] of [
      ["packages/integration/claude/skills", "../../skills"],
      ["packages/integration/cursor/skills", "../../skills"],
      ["packages/integration/pi/src/skills", "../../../skills"],
    ] as const) {
      const full = path.join(root, link)
      assert.isTrue(fs.lstatSync(full).isSymbolicLink(), `${link} must be a symlink`)
      assert.strictEqual(fs.readlinkSync(full), target)
      assert.strictEqual(fs.realpathSync(full), fs.realpathSync(skills))
    }

    const harnesses = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-skills-"))
    try {
      const built = childProcess.spawnSync(
        "bun",
        [path.join(root, "apps/vibest/scripts/build-harnesses.ts"), harnesses],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
      assert.strictEqual(built.status, 0, built.stderr + built.stdout)
      assert.isFalse(fs.existsSync(path.join(harnesses, "main-skills")))

      for (const id of ["pi", "claude", "cursor"] as const) {
        const dir = path.join(harnesses, id, "skills")
        assert.isFalse(fs.lstatSync(dir).isSymbolicLink(), `${id}/skills must be dereferenced`)
        const names = fs.readdirSync(dir).sort()
        assert.deepStrictEqual(names, ["delegate", "pipeline"])
        for (const name of names) {
          const skillDir = path.join(dir, name)
          const copied = path.join(skillDir, "SKILL.md")
          assert.isFalse(fs.lstatSync(skillDir).isSymbolicLink())
          assert.isFalse(fs.lstatSync(copied).isSymbolicLink())
          assert.strictEqual(frontmatterField(copied, "name"), name)
          assert.match(frontmatterField(copied, "description") ?? "", /Only vibest's main agent/)
          assert.isTrue(fs.readFileSync(copied).equals(fs.readFileSync(path.join(skills, name, "SKILL.md"))))
        }
      }

      for (const id of ["pi", "claude"] as const) {
        const pluginDir = path.join(harnesses, id)
        const input = coordinator(pluginDir)
        assert.strictEqual(input.env.VIBEST_AGENT, "coordinator")
        const args = ADAPTERS[id].coordinatorArgs!(input)
        assert.notInclude(args.join("\n"), "main-skills", id)
        assert.notInclude(args, "--no-skills", id)
        assert.notInclude(args, "--skill", id)
        if (id === "claude") {
          const plugins = args.filter((_, index) => args[index - 1] === "--plugin-dir")
          assert.deepStrictEqual(plugins, [pluginDir])
          assert.include(args[args.indexOf("--tools") + 1]!.split(","), "Skill")
        }
        if (id === "pi") {
          assert.strictEqual(args[args.indexOf("-e") + 1], path.join(pluginDir, "extension.mjs"))
        }
      }

      for (const id of ["pi", "claude", "cursor"] as const) {
        const pluginDir = path.join(harnesses, id)
        const input = launch(pluginDir)
        assert.notStrictEqual(input.env.VIBEST_AGENT, "coordinator")
        const args = ADAPTERS[id].launchArgs(input)
        const text = args.join("\n")
        assert.notInclude(text, "main-skills", id)
        assert.notInclude(args, "--skill", id)
        assert.notInclude(args, "--no-skills", id)
        if (args.includes("--tools")) assert.notInclude(args[args.indexOf("--tools") + 1]!.split(","), "Skill", id)
      }

      const files = JSON.parse(fs.readFileSync(path.join(root, "apps/vibest/package.json"), "utf8"))
        .files as Array<string>
      assert.include(files, "harnesses")
      assert.include(ARCHIVE_ROOTS, "harnesses")
    } finally {
      fs.rmSync(harnesses, { recursive: true, force: true })
    }
  })

  it.effect("Claude: each session runs a copy of the plugin directory holding only its definition's skills", () =>
    Effect.gen(function* () {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-plugin-"))
      for (const dir of [".claude-plugin", "hooks", "skills/delegate", "skills/pipeline"])
        fs.mkdirSync(path.join(base, dir), { recursive: true })
      fs.writeFileSync(path.join(base, "hooks", "hooks.json"), "{}")
      fs.writeFileSync(path.join(base, "skills", "delegate", "SKILL.md"), "d")
      const claude = ADAPTERS.claude
      const entry = yield* sessionPlugin(claude, base, "e2e-entry", ["delegate"])
      assert.notStrictEqual(entry, base)
      assert.deepStrictEqual(fs.readdirSync(path.join(entry, "skills")), ["delegate"])
      assert.isTrue(fs.existsSync(path.join(entry, "hooks", "hooks.json")))
      assert.isFalse(fs.lstatSync(path.join(entry, "hooks")).isSymbolicLink())
      const worker = yield* sessionPlugin(claude, base, "e2e-worker", [])
      assert.isFalse(fs.existsSync(path.join(worker, "skills")))
      // Made again on each start: a skill the definition no longer names is gone.
      yield* sessionPlugin(claude, base, "e2e-entry", [])
      assert.isFalse(fs.existsSync(path.join(entry, "skills")))
      // Pi picks its skills itself (VIBEST_SKILLS): its directory is used as it is.
      const pi = ADAPTERS.pi
      assert.strictEqual(yield* sessionPlugin(pi, base, "e2e-pi", []), base)
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "vibest-tmp-")) }),
        ),
      ),
      Effect.provide(Platform.services),
    ),
  )
})
