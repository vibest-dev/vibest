import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel } from "../fake-model.ts"
import { expect, herdr, readDb, replyOf, Skip, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"

type Listed = {
  agents: Array<{ id: string; description: string; plugin: string; harness?: string }>
  invalid: Array<{ id: string; source: string; error: string; plugin: string }>
}

type Entry = {
  id: string
  agent: string
  harness: string
  provider: string | null
  model: string | null
  address: { id: string }
  routing?: { decidedBy: Record<string, string> }
}

const GENERAL_START = "You are an agent executing a task assigned to you."

const needs = (...bins: Array<string>) => {
  for (const bin of bins) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
}

const fakePi = async (w: World, name: string) => {
  const model = heldModel()
  model.release()

  const dir = await piShadow(
    path.join(w.root, `pi-${name}`),
    w.profile,
    { first: { baseUrl: model.url, models: ["m", "m2"] }, second: { baseUrl: model.url, models: ["m", "m2"] } },
    { provider: "first", model: "m" },
  )

  return { model, dir }
}

const withEntry = async (w: World, name: string) => {
  const pi = await fakePi(w, name)
  await w.daemon({ env: { PI_CODING_AGENT_DIR: pi.dir } })
  await w.entry({ processEnv: { PI_CODING_AGENT_DIR: pi.dir } })

  return pi
}

const writeAgent = async (w: World, name: string, text: string) => {
  const file = path.join(w.vibestHome, "agents", name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(`${file}.tmp`, text)
  await fs.rename(`${file}.tmp`, file)

  return file
}

const listing = (w: World) => w.json<Listed>(["agent", "list"])

const listed = (w: World, what: string, ok: (l: Listed) => boolean) =>
  until(what, async () => ok(await listing(w)), 20_000)

const sessions = (w: World) => w.json<{ sessions: Array<Entry> }>(["ls", "--all"]).then((l) => l.sessions)

const entry = async (w: World, id: string) => (await sessions(w)).find((e) => e.id === id)

const runId = async (w: World, args: ReadonlyArray<string>) =>
  (JSON.parse(await w.okViaEntry(["run", ...args], { timeoutMs: 90_000 })) as { id: string }).id

const resultOf = (w: World, id: string, marker: string) =>
  until(`the answer of ${marker}`, async () => (await replyOf(w, id)).includes(`done-${marker}`), 90_000)

const extendsGeneral = (system: string, mark: string) => {
  const builtin = system.indexOf(GENERAL_START)

  return builtin >= 0 && builtin < system.indexOf(mark)
}

const claudeAgentsPlugin = (folder: string) => `import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
const folder = ${JSON.stringify(folder)}
const parse = (text) => {
  const [, head = "", body = ""] = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(text) ?? []
  const fields = Object.fromEntries(head.split("\\n").map((line) => line.split(/:\\s*/, 2)))
  return { fields, body: body.trim() }
}
export default Plugin.define({
  id: "claude-agents",
  effect: (ctx) =>
    ctx.agent
      .transform((editor) => {
        for (const name of fs.readdirSync(folder).filter((file) => file.endsWith(".md"))) {
          const { fields, body } = parse(fs.readFileSync(path.join(folder, name), "utf8"))
          editor.add({ id: fields.name, description: fields.description, system: body })
        }
      })
      .pipe(Effect.asVoid),
})
`

const checks: ReadonlyArray<Check> = [
  {
    id: "S60",
    title:
      "a file in ~/.vibest/agents defines an agent: vibest agent list shows it without restarting vibestd, vibest run --agent starts it with the extended prompt then the file's, every new session's facts list it, and removing the file removes it",
    run: async (w) => {
      needs("pi", "herdr")
      const { model } = await withEntry(w, "file")

      try {
        const pid = await w.daemonPid()

        const file = await writeAgent(
          w,
          "reviewer.md",
          "---\ndescription: reviews a change for real bugs\nextends: general\n---\nREVIEWER-MARK\n",
        )

        await listed(w, "reviewer listed", (l) =>
          l.agents.some((a) => a.id === "reviewer" && a.plugin === "vibest.agent-files"),
        )
        expect((await w.daemonPid()) === pid, "vibestd restarted to list the file")
        const id = await runId(w, ["--agent", "reviewer", "pi", "--", ask("reviewer")])
        await resultOf(w, id, "reviewer")
        expect((await entry(w, id))?.agent === "reviewer", `the session's agent: ${JSON.stringify(await entry(w, id))}`)
        const system = model.systemOf("reviewer") ?? ""
        expect(extendsGeneral(system, "REVIEWER-MARK"), "the prompt is not general's text followed by the file's")
        expect(system.includes("reviewer (reviews a change for real bugs)"), "the session facts do not list reviewer")
        await fs.rm(file)
        await listed(w, "reviewer gone", (l) => l.agents.every((a) => a.id !== "reviewer"))
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S61",
    title:
      "an invalid agent file is listed under invalid and by vibest doctor with its error, running it is refused with that error, and the other files still list and start",
    run: async (w) => {
      needs("pi", "herdr")
      const { model } = await withEntry(w, "invalid")

      try {
        await writeAgent(w, "Planner.md", "---\ndescription: plans\n---\nPlan.\n")
        const broken = await writeAgent(w, "broken.md", "---\ndescription: broken\ncolor: red\n---\nBroken.\n")
        await writeAgent(w, "fine.md", "---\ndescription: works\n---\nFINE-MARK\n")
        await listed(
          w,
          "fine listed, broken and Planner invalid",
          (l) => l.agents.some((a) => a.id === "fine") && l.invalid.length === 2,
        )
        const { invalid } = await listing(w)
        const brokenEntry = invalid.find((a) => a.id === "broken")
        expect(
          brokenEntry?.source === broken && brokenEntry.error.includes("unknown key color"),
          `broken: ${JSON.stringify(invalid)}`,
        )
        expect(invalid.find((a) => a.id === "Planner")?.error.includes("lowercase") === true, JSON.stringify(invalid))
        const doctor = await w.vibest(["doctor"], { timeoutMs: 120_000 })
        expect(
          doctor.stdout.includes("broken: unknown key color") && doctor.stdout.includes(`fix or remove ${broken}`),
          `doctor: ${doctor.stdout}`,
        )
        const refused = await w.viaEntry(["run", "--agent", "broken", "pi", "--", ask("broken")])
        expect(
          refused.code !== 0 && refused.stdout.includes("is invalid") && refused.stdout.includes("unknown key color"),
          `run --agent broken: ${refused.code} ${refused.stdout}`,
        )
        const id = await runId(w, ["--agent", "fine", "pi", "--", ask("fine")])
        await resultOf(w, id, "fine")
        expect((model.systemOf("fine") ?? "").includes("FINE-MARK"), "fine's prompt")
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S62",
    title:
      "an agent file's harness, provider and model start a run that names no harness, and vibest ls names the agent as their decider; a run that names the harness does not take them",
    run: async (w) => {
      needs("pi", "herdr")
      const { model } = await withEntry(w, "launch")

      try {
        await writeAgent(
          w,
          "astra.md",
          "---\ndescription: reviews on the second provider\nharness: pi\nprovider: second\nmodel: m2\n---\nASTRA-MARK\n",
        )
        await listed(w, "astra listed", (l) => l.agents.some((a) => a.id === "astra" && a.harness === "pi"))
        const ownId = await runId(w, ["--agent", "astra", "--", ask("own")])
        const own = await entry(w, ownId)
        expect(
          own?.harness === "pi" &&
            own.provider === "second" &&
            own.model === "m2" &&
            ["harness", "provider", "model"].every((field) => own.routing?.decidedBy[field] === "agent:astra"),
          `astra without a harness: ${JSON.stringify(own)}`,
        )
        await resultOf(w, ownId, "own")
        const named = await entry(w, await runId(w, ["--agent", "astra", "pi", "--", ask("named")]))
        expect(
          named?.harness === "pi" && named.provider === null && named.model === null,
          `astra with pi named: ${JSON.stringify(named)}`,
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S63",
    title:
      "a file general.md with extends: general replaces the builtin general: a plain vibest run gets the builtin text and then the file's, and removing the file restores the builtin",
    run: async (w) => {
      needs("pi", "herdr")
      const { model } = await withEntry(w, "general")

      try {
        const file = await writeAgent(
          w,
          "general.md",
          "---\ndescription: does the work itself, with my rules\nextends: general\n---\nGENERAL-PLUS-MARK\n",
        )

        await listed(w, "general from the file", (l) =>
          l.agents.some((a) => a.id === "general" && a.plugin === "vibest.agent-files"),
        )
        const id = await runId(w, ["pi", "--", ask("plain")])
        await resultOf(w, id, "plain")
        expect(extendsGeneral(model.systemOf("plain") ?? "", "GENERAL-PLUS-MARK"), "plain run's prompt")
        await fs.rm(file)
        await listed(w, "builtin general back", (l) =>
          l.agents.some((a) => a.id === "general" && a.plugin === "vibest.agent"),
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S64",
    title:
      "vibest --agent opens a project's entry session as that agent on its harness; naming another agent without --new is refused and changes nothing; bare vibest reopens it as the same agent",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "lead")
      const env = { PI_CODING_AGENT_DIR: dir }

      try {
        await writeAgent(
          w,
          "lead.md",
          "---\ndescription: leads the work\nharness: pi\nprovider: first\n---\nLEAD-MARK\n",
        )
        await w.daemon({ env })
        await listed(w, "lead listed", (l) => l.agents.some((a) => a.id === "lead"))
        await w.startEntry({ extra: ["--agent", "lead"], env, timeoutMs: 90_000 })
        let lead: Entry | undefined
        await until(
          "the entry session as lead",
          async () => (lead = (await sessions(w)).find((e) => e.agent === "lead")) !== undefined,
          60_000,
        )
        expect(
          lead!.harness === "pi" && lead!.provider === "first" && lead!.routing?.decidedBy.harness === "agent:lead",
          `entry session: ${JSON.stringify(lead)}`,
        )

        const processes = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return db
              .query<{ readyAt: number | null; endedAt: number | null }, [string]>(
                "SELECT ready_at AS readyAt, ended_at AS endedAt FROM process WHERE session_id = ? ORDER BY id",
              )
              .all(lead!.id)
          } finally {
            db.close()
          }
        }

        await until("the entry session ready", () => processes().some((p) => p.readyAt !== null), 60_000)
        const other = await w.vibest(["--headless", "--agent", "general"], { env, timeoutMs: 60_000 })
        expect(
          other.code !== 0 && /add --new/.test(other.stderr + other.stdout),
          `--agent general without --new: ${other.code} ${other.stderr}${other.stdout}`,
        )
        expect(processes().length === 1, "the refused start started a process")
        const socket = path.join(w.home, ".config", "herdr", "sessions", w.herdrSession, "herdr.sock")
        await herdr(socket, "pane.close", { pane_id: lead!.address.id.split("/").pop()! })
        await until("the entry session's exit recorded", () => processes().some((p) => p.endedAt !== null), 30_000)
        const again = await w.vibest(["--headless"], { env, timeoutMs: 60_000 })
        expect(again.code === 0, `bare vibest: ${again.code} ${again.stderr}${again.stdout}`)
        await until("a second start", () => processes().length === 2, 30_000)
        const reopened = (await sessions(w)).filter((e) => e.agent === "lead" || e.agent === "coordinator")
        expect(
          reopened.length === 1 && reopened[0]!.id === lead!.id && reopened[0]!.agent === "lead",
          `after bare vibest: ${JSON.stringify(reopened)}`,
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S65",
    title:
      "a home plugin registers an agent read from a Claude Code style .claude/agents/<name>.md file: vibest agent list names the plugin and vibest run --agent starts it with the file's prompt",
    run: async (w) => {
      needs("pi", "herdr")
      const { model } = await withEntry(w, "claudefmt")
      const folder = path.join(w.root, "claude-project", ".claude", "agents")

      try {
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(
          path.join(folder, "code-reviewer.md"),
          "---\nname: code-reviewer\ndescription: Reviews code for quality\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nYou are a senior code reviewer. CLAUDE-FORMAT-MARK\n",
        )
        const plugin = path.join(w.vibestHome, "plugins", "claude-agents.ts")
        await fs.mkdir(path.dirname(plugin), { recursive: true })
        await fs.writeFile(plugin, claudeAgentsPlugin(folder))
        await listed(w, "code-reviewer from the plugin", (l) =>
          l.agents.some((a) => a.id === "code-reviewer" && a.plugin === "claude-agents"),
        )
        const mapped = (await listing(w)).agents.find((a) => a.id === "code-reviewer")
        expect(
          mapped?.description === "Reviews code for quality" && mapped.harness === undefined,
          `only vibest fields are taken from the Claude file: ${JSON.stringify(mapped)}`,
        )
        const id = await runId(w, ["--agent", "code-reviewer", "pi", "--", ask("claudefmt")])
        await resultOf(w, id, "claudefmt")
        expect((model.systemOf("claudefmt") ?? "").includes("CLAUDE-FORMAT-MARK"), "the Claude-format prompt")
      } finally {
        model.stop()
      }
    },
  },
]

export default checks
