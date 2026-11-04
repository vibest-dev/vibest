// The pre-tool guard as a harness plugin runs it. Cursor's: `vibest integration event --harness cursor preToolUse`, the
// hook's payload on stdin, the agent's environment (vibestd decodes it with the cursor adapter). Claude's: `POST /guard`
// on vibestd's HTTP socket with the neutral tool call, as a session vibestd knows. Both plugins ask only for a vibest
// agent (I4, I9 run them for real); Pi's extension posts to `/guard` the same way (needs Pi running: runtime, not here).
import path from "node:path"

import { sessionHeaders } from "../../../../packages/protocol/src/protocol.ts"
import { toolCallOf } from "../../../../packages/protocol/src/tools.ts"
import type { Check } from "../check.ts"
import { binary, expect, knownSessions, type World } from "../world.ts"

type Harness = "claude" | "cursor"
type Answer = { code: number; decision: "deny" | "allow" | "none"; reason: string }

/** Each harness's guard sessions (UUIDs, as vibest makes them). */
const SESSIONS: Record<Harness, Record<"general" | "coordinator", string>> = {
  claude: { general: "e2e0a001-e2e0-4e2e-8e2e-e2e0a001e2e0", coordinator: "e2e0c001-e2e0-4e2e-8e2e-e2e0c001e2e0" },
  cursor: { general: "e2e0a002-e2e0-4e2e-8e2e-e2e0a002e2e0", coordinator: "e2e0c002-e2e0-4e2e-8e2e-e2e0c002e2e0" },
}
/** The project of each world's guard sessions per harness, made on first use. */
const projects = new WeakMap<World, Map<Harness, Promise<string>>>()
const projectOf = (w: World, harness: Harness) => {
  const own = projects.get(w) ?? new Map<Harness, Promise<string>>()
  projects.set(w, own)
  const { general, coordinator } = SESSIONS[harness]
  if (!own.has(harness))
    own.set(harness, knownSessions(w, { [general]: "general", [coordinator]: "coordinator" }, w.repository, harness))
  return own.get(harness)!
}
/** The project folder of a harness's guard sessions (VIBEST_PROJECT_DIR). */
const projectDir = async (w: World, harness: Harness) =>
  path.join(w.vibestHome, "projects", await projectOf(w, harness))

/** One tool call through the guard. `agent` undefined: no vibest agent. `raw` replaces the input. */
const ask = async (
  w: World,
  harness: Harness,
  agent: string | undefined,
  tool: string,
  input: Record<string, unknown>,
  raw?: string,
): Promise<Answer> => {
  const sessionId = SESSIONS[harness][agent === "coordinator" ? "coordinator" : "general"]
  if (harness === "claude" && agent !== undefined) {
    const projectId = await projectOf(w, harness)
    const r = await fetch("http://vibestd/guard", {
      method: "POST",
      unix: path.join(w.vibestHome, "vibest-http.sock"),
      headers: { ...sessionHeaders({ sessionId, projectId, agent, harness }), "content-type": "application/json" },
      body: raw ?? JSON.stringify({ tool: toolCallOf(tool, input, w.repository) }),
    })
    const json = (await r.json()) as { deny?: string; error?: string }
    if (r.status !== 200) return { code: r.status, decision: "none", reason: json.error ?? "" }
    return { code: 0, decision: json.deny === undefined ? "none" : "deny", reason: json.deny ?? "" }
  }
  const stdin = raw ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: w.repository })
  const env =
    agent === undefined
      ? {}
      : {
          VIBEST_AGENT: agent,
          VIBEST_SESSION_ID: sessionId,
          VIBEST_PROJECT_ID: await projectOf(w, harness),
          VIBEST_PROJECT_DIR: await projectDir(w, harness),
          VIBEST_HARNESS: harness,
        }
  const r = await w.run(w.repository, [binary, "integration", "event", "--harness", harness, "preToolUse"], {
    env,
    stdin,
  })
  const out = r.stdout.trim()
  if (!out) return { code: r.code, decision: "none", reason: r.stderr }
  const json = JSON.parse(out)
  return { code: r.code, decision: json.permission, reason: json.user_message ?? "" }
}

const shell = (harness: Harness) => (harness === "claude" ? "Bash" : "Shell")
const both: ReadonlyArray<Harness> = ["claude", "cursor"]

const checks: ReadonlyArray<Check> = [
  {
    id: "R1",
    title: "an agent driving herdr itself is denied, in each harness's answer format",
    run: async (w) => {
      for (const h of both) {
        for (const agent of ["general", "coordinator"]) {
          const a = await ask(w, h, agent, shell(h), { command: "herdr pane list" })
          expect(a.code === 0 && a.decision === "deny" && a.reason.length > 0, `${h} ${agent}: ${JSON.stringify(a)}`)
        }
      }
    },
  },
  {
    id: "R2",
    title: "a session reads and writes its own project folder (VIBEST_PROJECT_DIR); another project's folder is denied",
    run: async (w) => {
      const other = path.join(w.vibestHome, "projects", "00000000-0000-4000-8000-000000000000", "memories", "a.md")
      for (const h of both) {
        const own = path.join(await projectDir(w, h), "memories", "a.md")
        const allowed = h === "cursor" ? "allow" : "none"
        for (const [file, decision] of [
          [own, allowed],
          [other, "deny"],
        ] as const)
          for (const [tool, input] of [
            [shell(h), { command: `cat ${file}` }],
            ["Read", { file_path: file }],
            ["Write", { file_path: file, content: "x" }],
          ] as const) {
            const a = await ask(w, h, "general", tool, input)
            expect(a.decision === decision, `${h} ${tool} ${file}: ${JSON.stringify(a)}`)
          }
      }
    },
  },
  {
    id: "R3",
    title: "ordinary work is allowed for both roles; the coordinator edits files only in its project folder",
    run: async (w) => {
      for (const h of both) {
        const allowed = h === "cursor" ? "allow" : "none"
        const c = await ask(w, h, "coordinator", shell(h), { command: "git log -1" })
        expect(c.code === 0 && c.decision === allowed, `${h} coordinator: ${JSON.stringify(c)}`)
        const s = await ask(w, h, "general", shell(h), { command: "git status" })
        expect(s.code === 0 && s.decision === allowed, `${h} session git status: ${JSON.stringify(s)}`)
        const e = await ask(w, h, "coordinator", "Write", { file_path: path.join(w.repository, "x.txt"), content: "x" })
        expect(e.decision === "deny", `${h} coordinator edit: ${JSON.stringify(e)}`)
        const plan = path.join(await projectDir(w, h), "artifacts", "plan.md")
        const p = await ask(w, h, "coordinator", "Write", { file_path: plan, content: "x" })
        expect(p.decision === allowed, `${h} coordinator edit in its project folder: ${JSON.stringify(p)}`)
      }
    },
  },
  {
    id: "R4",
    title: "without a vibest agent the guard answers nothing and fails (the plugin does not ask it then)",
    run: async (w) => {
      // Claude's plugin makes no request without a vibest agent (packages/integration/claude/test/plugin.test.ts).
      for (const h of ["cursor"] as const) {
        const a = await ask(w, h, undefined, shell(h), { command: "git status" })
        expect(a.code !== 0 && a.decision === "none", `${h}: ${JSON.stringify(a)}`)
      }
    },
  },
  {
    id: "R5",
    title: "input vibest cannot read is refused: vibestd denies it over HTTP; the CLI fails, which the plugin refuses",
    run: async (w) => {
      const c = await ask(w, "claude", "general", "Bash", {}, "not json")
      expect(c.decision === "deny", `claude: ${JSON.stringify(c)}`)
      const a = await ask(w, "cursor", "general", "Shell", {}, "not json")
      expect(a.code !== 0 && a.decision === "none", `cursor: ${JSON.stringify(a)}`)
    },
  },
]

export default checks
