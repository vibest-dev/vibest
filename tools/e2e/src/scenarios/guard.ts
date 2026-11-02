// The pre-tool guard as a harness plugin runs it: `vibest integration guard --harness <h>`, the tool call on stdin, the
// agent's environment. Claude's and Cursor's plugins call it only for a vibest agent (I9 runs Cursor's for real); Pi's
// extension applies the same rules in process (needs Pi running: runtime, not here).
import path from "node:path"
import type { Check } from "../check.ts"
import { binary, expect, type World } from "../world.ts"

type Harness = "claude" | "cursor"
type Answer = { code: number; decision: "deny" | "allow" | "none"; reason: string }

/** One tool call through the guard. `agent` undefined: no vibest agent. `raw` replaces the input. */
const ask = async (w: World, harness: Harness, agent: string | undefined, tool: string, input: Record<string, unknown>, raw?: string): Promise<Answer> => {
  const stdin = raw ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: w.repository })
  const env = agent === undefined ? {} : { VIBEST_AGENT: agent, VIBEST_SESSION_ID: "e2e00001" }
  const r = await w.run(w.repository, [binary, "integration", "guard", "--harness", harness], { env, stdin })
  const out = r.stdout.trim()
  if (!out) return { code: r.code, decision: "none", reason: r.stderr }
  const json = JSON.parse(out)
  if (harness === "cursor") return { code: r.code, decision: json.permission, reason: json.user_message ?? "" }
  const d = json.hookSpecificOutput
  return { code: r.code, decision: d?.permissionDecision ?? "none", reason: d?.permissionDecisionReason ?? "" }
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
    title: "a session reading the project store's files directly is denied",
    run: async (w) => {
      const file = path.join(w.vibestHome, "projects", "x", "memory", "a.md")
      for (const h of both) {
        for (const [tool, input] of [[shell(h), { command: `cat ${file}` }], ["Read", { file_path: file }]] as const) {
          const a = await ask(w, h, "general", tool, input)
          expect(a.decision === "deny", `${h} ${tool}: ${JSON.stringify(a)}`)
        }
      }
    },
  },
  {
    id: "R3",
    title: "ordinary work is allowed for both roles; the coordinator edits no file",
    run: async (w) => {
      for (const h of both) {
        const allowed = h === "cursor" ? "allow" : "none"
        const c = await ask(w, h, "coordinator", shell(h), { command: "git log -1" })
        expect(c.code === 0 && c.decision === allowed, `${h} coordinator: ${JSON.stringify(c)}`)
        const s = await ask(w, h, "general", shell(h), { command: "git status" })
        expect(s.code === 0 && s.decision === allowed, `${h} session git status: ${JSON.stringify(s)}`)
        const e = await ask(w, h, "coordinator", "Write", { file_path: path.join(w.repository, "x.txt"), content: "x" })
        expect(e.decision === "deny", `${h} coordinator edit: ${JSON.stringify(e)}`)
      }
    },
  },
  {
    id: "R4",
    title: "without a vibest agent the guard answers nothing and fails (the plugin does not ask it then)",
    run: async (w) => {
      for (const h of both) {
        const a = await ask(w, h, undefined, shell(h), { command: "git status" })
        expect(a.code !== 0 && a.decision === "none", `${h}: ${JSON.stringify(a)}`)
      }
    },
  },
  {
    id: "R5",
    title: "input vibest cannot read fails, which the plugin turns into a refusal",
    run: async (w) => {
      for (const h of both) {
        const a = await ask(w, h, "general", shell(h), {}, "not json")
        expect(a.code !== 0 && a.decision === "none", `${h}: ${JSON.stringify(a)}`)
      }
    },
  },
]

export default checks
