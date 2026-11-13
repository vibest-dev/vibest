import path from "node:path"

import type { Check } from "../check.ts"
import { compiled, expect, harnesses, herdr, row, SESSIONS, Skip, until, type World, writeEvidence } from "../world.ts"
import { addAgyPlugin } from "../world/plugins.ts"
import { addressOf, isolatedCore } from "./hc.ts"
import { project } from "./inbox.ts"
import { executionState, latest, withSession } from "./integration.ts"

const binaryOf = () => process.env.VIBEST_E2E_AGY_BINARY ?? "agy"

const signedIn = async (w: World) => {
  const binary = binaryOf()
  if (!Bun.which(binary, { PATH: w.env().PATH! })) throw new Skip(`${binary} not on PATH`)
  const models = await w.run(w.repository, [binary, "--output-format", "json", "models"], { timeoutMs: 120_000 })
  if (models.code !== 0)
    throw new Skip(
      `${binary} is not signed in (set VIBEST_E2E_AGY_BINARY and AGY_PROFILE to use a wrapper): ${models.stderr.trim()}`,
    )
  return binary
}

const completed = (w: World, id: string) =>
  row<{ n: number }>(w, "SELECT count(*) AS n FROM execution WHERE session_id = ? AND outcome = 'completed'", id)?.n ??
  0

const untilShown = async (
  w: World,
  id: string,
  evidence: string,
  what: string,
  ok: () => boolean | Promise<boolean>,
) => {
  try {
    await until(what, ok, 300_000)
  } catch (error) {
    const screen = await w.run(w.repository, [compiled, "peek", id])
    const listing = await w.run(w.repository, [compiled, "ls"])
    await writeEvidence(path.join(evidence, "agy-screen.txt"), `${what}\n${listing.stdout}\n${screen.stdout}`)
    throw error
  }
}

const PONG = (n: number) =>
  `Reply with exactly: PONG-AGY-${n}. Remember the word COBALT-PINE. Run no command and use no tool: answer in this terminal only.`

const checks: ReadonlyArray<Check> = [
  {
    id: "H9",
    tier: "agent",
    title:
      "agy (real): with its plugin added, the harness is listed as available, its models and its usage windows come from the CLI without a model turn",
    run: async (w) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await addAgyPlugin(w, harnesses, binary)
      await w.ok(["daemon"])
      const list = await w.json<Array<{ harness: string; binary: string; available: boolean }>>(["harness", "list"], {
        timeoutMs: 120_000,
      })
      const found = list.find((h) => h.harness === "agy")
      expect(found?.available === true && found.binary === binary, `harness list: ${JSON.stringify(list)}`)
      const models = await w.json<{ models: Array<{ harness: string; model: string }> }>(["models"], {
        timeoutMs: 120_000,
      })
      expect(
        models.models.some((m) => m.harness === "agy" && m.model !== ""),
        `models: ${JSON.stringify(models).slice(0, 500)}`,
      )
      await until(
        "agy's usage windows",
        async () => {
          const rows = await w.json<Array<{ harness: string; limits: Array<{ window: string }>; error?: string }>>([
            "subscriptions",
          ])
          return rows.some((r) => r.harness === "agy" && r.limits.length > 0)
        },
        120_000,
      )
    },
  },
  {
    id: "H10",
    tier: "agent",
    title:
      "agy (real): vibest run agy completes its execution when agy goes idle, with no reply text and the conversation id recorded; a send is the next execution; after its pane closes a send resumes the same conversation (it still knows the word it was given)",
    run: async (w, evidence) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await addAgyPlugin(w, harnesses, binary)
      await withSession(w, "agy", [], PONG(1), async ({ id, socket }) => {
        await untilShown(
          w,
          id,
          evidence,
          "the first execution completed",
          async () => (await executionState(w, id)) === "completed",
        )
        const first = await latest(w, id)
        expect(first?.status === "completed" && first.message === "", `the first result: ${JSON.stringify(first)}`)
        await until(
          "the conversation id",
          () =>
            (row<{ c: string | null }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, id)?.c ??
              "") !== "",
          30_000,
        )
        const screen = await w.ok(["peek", id])
        expect(screen.includes("PONG-AGY-1"), `agy's screen after the first task: ${screen.slice(-800)}`)

        await w.ok(["send", id, PONG(2)])
        await untilShown(w, id, evidence, "the second execution completed", () => completed(w, id) === 2)
        expect((await w.ok(["peek", id])).includes("PONG-AGY-2"), "agy's screen after the send")

        const pane = (await w.json<{ sessions: Array<{ id: string; address?: { id: string } }> }>(["ls"])).sessions
          .find((s) => s.id === id)
          ?.address?.id.split("/")[1]
        await herdr(socket, "pane.close", { pane_id: pane ?? "" })
        await until(
          "the session exited",
          async () =>
            row<{ e: number | null }>(w, `SELECT exited_at AS e FROM ${SESSIONS} s WHERE id = ?`, id)?.e != null,
          60_000,
        )
        const before = row<{ c: string }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, id)!.c
        await w.ok([
          "send",
          id,
          "What word did I ask you to remember? Reply with exactly: WORD-<the word>. Run no command and use no tool.",
        ])
        await untilShown(w, id, evidence, "the resumed execution completed", () => completed(w, id) === 3)
        const after = row<{ c: string }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, id)!.c
        expect(after === before, `the conversation changed: ${before} -> ${after}`)
        const resumed = await w.ok(["peek", id])
        expect(resumed.includes("WORD-COBALT-PINE"), `the resumed agy lost the word: ${resumed.slice(-800)}`)
      })
    },
  },
  {
    id: "H12",
    tier: "agent",
    title:
      "agy (real) as the entry session: a message sent to it while it is idle is typed into agy and completes as an execution of the entry session",
    run: async (w) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await addAgyPlugin(w, harnesses, binary)
      const session = `${w.herdrSession}-agy-entry`
      const repo = await project(w, "agy-entry")
      await w.startEntry({ harness: "agy", session, cwd: repo, timeoutMs: 240_000 })
      try {
        const entry = (await w.entryOf(repo))!
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        const pane = async () =>
          (await w.json<{ sessions: Array<{ id: string; address?: { id: string } }> }>(["ls"], { cwd: repo })).sessions
            .find((s) => s.id === entry)
            ?.address?.id.split("/")[1] ?? ""
        await until(
          "agy idle in the entry pane",
          async () => {
            const read = await herdr(socket, "pane.read", { pane_id: await pane(), source: "visible" })
            const text = JSON.stringify(read)
            if (text.includes("Yes, I trust this folder"))
              await herdr(socket, "pane.send_keys", { pane_id: await pane(), keys: ["enter"] })
            const listed = await w.json<{ sessions: Array<{ id: string; status: string }> }>(["ls"], { cwd: repo })
            return listed.sessions.find((x) => x.id === entry)?.status === "idle"
          },
          180_000,
        )
        const before = completed(w, entry)
        await w.ok(["send", entry, "--", PONG(1)], { cwd: repo })
        await until(
          "the sent message answered and its execution completed",
          async () =>
            completed(w, entry) > before &&
            JSON.stringify(await herdr(socket, "pane.read", { pane_id: await pane(), source: "recent" })).includes(
              "PONG-AGY-1",
            ),
          300_000,
        )
      } finally {
        await w.stopDaemon()
        await w.run(w.root, ["herdr", "session", "stop", session])
        await w.run(w.root, ["herdr", "session", "delete", session])
      }
    },
  },
  {
    id: "H11",
    tier: "agent",
    title:
      "agy (real) on herdr-core: its session-only status line reports working while it answers and idle after, as the terminal's status, and the execution completes from those reports",
    run: async (w) => {
      if (!Bun.which("hc")) throw new Skip("hc not on PATH")
      const binary = await signedIn(w)
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      await addAgyPlugin(w, harnesses, binary)
      const core = await isolatedCore(w, w.config.pi, "agy-hc")
      try {
        const repo = await project(w, "agy-hc")
        await w.entry({ cwd: repo, runtime: "hc", name: "agy-hc-main", hc: { run: core.hc } })
        const run = await w.okViaEntry(["run", "agy", "--runtime", "hc", "--", PONG(1)], {
          cwd: repo,
          asIs: true,
          timeoutMs: 120_000,
        })
        const id = (JSON.parse(run) as { id: string }).id
        const terminal = () => {
          const at = JSON.parse(
            row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, id)?.runtime ?? "{}",
          ) as { id?: string }
          return addressOf(at.id ?? "@")
        }
        const statusOf = async () => {
          const out = (await core.hc("get", terminal(), "--json")).stdout
          return out.trim() === ""
            ? "none"
            : ((JSON.parse(out) as { status?: { state: string } }).status?.state ?? "none")
        }
        const seen = new Set<string>()
        await until(
          "the execution completed",
          async () => {
            seen.add(await statusOf())
            return completed(w, id) === 1
          },
          300_000,
        ).catch(async (error: Error) => {
          throw new Error(`${error.message}; terminal states seen: ${[...seen]}\n${await core.screens()}`)
        })
        const status = await statusOf()
        expect(status === "idle", `the terminal ends ${status}`)
        expect(seen.has("working"), `the terminal was never working: ${[...seen]}`)
      } finally {
        await core.stop()
      }
    },
  },
]

export default checks
