import path from "node:path"

import { sessionHeaders } from "../../../../packages/protocol/src/protocol.ts"
import type { Check } from "../check.ts"
import { binary, expect, knownSessions, type World } from "../world.ts"

type Harness = "claude" | "cursor"
type Answer = { code: number; decision: "deny" | "allow" | "none"; reason: string }

const GENERAL = "e2e0a001-e2e0-4e2e-8e2e-e2e0a001e2e0"
const COORDINATOR = "e2e0c001-e2e0-4e2e-8e2e-e2e0c001e2e0"
const projects = new WeakMap<World, Promise<string>>()
const guardSessionsProject = (w: World) => {
  projects.set(w, projects.get(w) ?? knownSessions(w, { [GENERAL]: "general", [COORDINATOR]: "coordinator" }))
  return projects.get(w)!
}
const projectDir = async (w: World) => path.join(w.vibestHome, "projects", await guardSessionsProject(w))

const ask = async (
  w: World,
  harness: Harness,
  agent: string | undefined,
  tool: string,
  input: Record<string, unknown>,
  rawStdin?: string,
): Promise<Answer> => {
  const stdin = rawStdin ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: w.repository })
  if (harness === "claude" && agent !== undefined) {
    const sessionId = agent === "coordinator" ? COORDINATOR : GENERAL
    const projectId = await guardSessionsProject(w)
    const r = await fetch("http://vibestd/hooks/claude/guard", {
      method: "POST",
      unix: path.join(w.vibestHome, "vibest-http.sock"),
      headers: { ...sessionHeaders({ sessionId, projectId, agent, harness }), "content-type": "application/json" },
      body: stdin,
    })
    const json = (await r.json()) as { deny?: string; error?: string }
    if (r.status !== 200) return { code: r.status, decision: "none", reason: json.error ?? "" }
    return { code: 0, decision: json.deny === undefined ? "none" : "deny", reason: json.deny ?? "" }
  }
  const env =
    agent === undefined
      ? {}
      : {
          VIBEST_AGENT: agent,
          VIBEST_SESSION_ID: "e2e00001-e2e0-4e2e-8e2e-e2e00001e2e0",
          VIBEST_PROJECT_DIR: await projectDir(w),
        }
  const r = await w.run(w.repository, [binary, "integration", "guard", "--harness", harness], { env, stdin })
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
      const own = path.join(await projectDir(w), "memories", "a.md")
      const other = path.join(w.vibestHome, "projects", "00000000-0000-4000-8000-000000000000", "memories", "a.md")
      for (const h of both) {
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
        const plan = path.join(await projectDir(w), "artifacts", "plan.md")
        const p = await ask(w, h, "coordinator", "Write", { file_path: plan, content: "x" })
        expect(p.decision === allowed, `${h} coordinator edit in its project folder: ${JSON.stringify(p)}`)
      }
    },
  },
  {
    id: "R4",
    title: "without a vibest agent the guard answers nothing and fails (the plugin does not ask it then)",
    run: async (w) => {
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
