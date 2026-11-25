import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { compiled, expect, harnesses, herdr, row, rows, SESSIONS, Skip, until, type World } from "../world.ts"
import { useAgyBinary } from "../world/plugins.ts"
import { hcKey } from "./cursor.ts"
import { isolatedCore } from "./hc.ts"
import { dropHerdrSession, project } from "./inbox.ts"
import { executionState, latest, withSession } from "./integration.ts"

const binaryOf = () => process.env.VIBEST_E2E_AGY_BINARY ?? "agy"

const signedIn = async (w: World) => {
  const binary = binaryOf()

  if (!Bun.which(binary, { PATH: w.env().PATH! })) throw new Skip(`${binary} not on PATH`)
  const models = await w.run(w.repository, [binary, "--output-format", "json", "models"], { timeoutMs: 120_000 })

  if (models.code !== 0)
    throw new Skip(
      `${binary} is not signed in (set AGYX_PROFILE to the agyx profile to use, and VIBEST_E2E_AGY_BINARY to a wrapper): ${models.stderr.trim()}`,
    )

  return binary
}

const daemonLog = (w: World) => fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")

type Runtime = "herdr" | "hc"

export const agyWorld = async (w: World, runtime: Runtime, name: string, entry: "pi" | "agy") => {
  const repo = await project(w, name)
  const session = `${w.herdrSession}-${name}`
  const herdrSocket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const core = runtime === "hc" ? await isolatedCore(w, w.config.pi, name) : undefined

  if (core) w.ownRuntimes.add("hc")

  const placement = core
    ? { runtime: "hc", extra: ["--runtime", "hc"], hc: { run: core.hc }, name: `${name}-entry` }
    : { session }

  if (entry === "pi") await w.entry({ cwd: repo, ...placement })
  else {
    await w.ok(["daemon"], { cwd: repo })
    await w.startEntry({ harness: "agy", cwd: repo, timeoutMs: 240_000, ...placement })
  }

  const terminalOf = (id: string) => {
    const at =
      (
        JSON.parse(row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, id)?.r ?? "{}") as {
          id?: string
        }
      ).id ?? ""

    return core ? (at.split("@")[0] ?? "") : (at.split("/")[1] ?? "")
  }

  const screen = async (id: string) => {
    if (core) return (await core.hc("read", terminalOf(id))).stdout

    const read = await herdr(herdrSocket, "pane.read", {
      pane_id: terminalOf(id),
      source: "visible",
      strip_ansi: true,
    }).catch((e: Error) => ({ read: { text: `(no screen: ${e.message})` } }))

    return String((read.read as { text?: string } | undefined)?.text ?? "")
  }

  const typeText = async (id: string, text: string) => {
    if (core) {
      const r = await core.hc("keys", terminalOf(id), ...[...text].map(hcKey))
      expect(r.code === 0, `hc keys: ${r.stderr}${r.stdout}`)
    } else await herdr(herdrSocket, "pane.send_text", { pane_id: terminalOf(id), text })
  }

  const pressKeys = async (id: string, keys: ReadonlyArray<string>) => {
    if (core) {
      const r = await core.hc("keys", terminalOf(id), ...keys)
      expect(r.code === 0, `hc keys: ${r.stderr}${r.stdout}`)
    } else await herdr(herdrSocket, "pane.send_keys", { pane_id: terminalOf(id), keys })
  }

  const argv = async (id: string) => {
    if (core) return (await core.hc("get", terminalOf(id), "--json")).stdout
    const info = await herdr(herdrSocket, "pane.process_info", { pane_id: terminalOf(id) })

    return JSON.stringify(info)
  }

  const listed = async (id: string) =>
    (
      await w.json<{ sessions: Array<{ id: string; status: string; executionState: string }> }>(["ls"], { cwd: repo })
    ).sessions.find((e) => e.id === id)

  const entryIdle = async () => {
    const id = (await w.entryOf(repo))!
    await until(
      "agy idle in the entry pane",
      async () => {
        if ((await screen(id)).includes("Yes, I trust this folder")) await pressKeys(id, ["enter"])

        return (await screen(id)).includes("for shortcuts")
      },
      180_000,
    )

    return id
  }

  const executions = (id: string) =>
    rows<{ id: number; outcome: string | null }>(
      w,
      "SELECT id, outcome FROM execution WHERE session_id = ? ORDER BY id",
      id,
    )

  const close = async () => {
    await w.stopDaemon()

    if (core) await core.stop()
    else await dropHerdrSession(w, session)
  }

  return { repo, core, session, terminalOf, screen, typeText, pressKeys, argv, listed, entryIdle, executions, close }
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
    await w.writeEvidence(path.join(evidence, "agy-screen.txt"), `${what}\n${listing.stdout}\n${screen.stdout}`)
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
      "agy (real): loaded by default, the harness is listed as available, its models come from the CLI without a model turn, and `vibest subscriptions` has no agy row",
    run: async (w) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
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

      const rows = await w.json<Array<{ harness: string }>>(["subscriptions"])
      expect(!rows.some((r) => r.harness === "agy"), `subscriptions: ${JSON.stringify(rows)}`)
    },
  },
  {
    id: "H10",
    tier: "agent",
    title:
      "agy (real): vibest run agy completes its execution at agy's Stop hook, with no reply text and the conversation id recorded from its SessionStart; a send is the next execution; after its pane closes a send resumes the same conversation (it still knows the word it was given)",
    run: async (w, evidence) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
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
        expect(
          (await daemonLog(w)).includes(`execution end ${id} (agy, completed)`),
          "the execution did not end at agy's Stop hook",
        )
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

        const pane = (
          await w.json<{ sessions: Array<{ id: string; terminal?: { target: { pane?: string } } | null }> }>(["ls"])
        ).sessions.find((s) => s.id === id)?.terminal?.target.pane

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
    id: "H11",
    tier: "agent",
    title:
      "agy (real) on herdr-core, which has no state for it: a session vibest starts takes its first message in its launch argv and completes it at Stop; a message sent when it is idle again is typed and completes; after its terminal is gone a message resumes the conversation with the message in the argv",
    run: async (w, evidence) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
      const a = await agyWorld(w, "hc", "agy-h11", "pi")

      try {
        const { id } = JSON.parse(
          await w.okViaEntry(["run", "agy", "--runtime", "hc", "--", PONG(1)], { cwd: a.repo, timeoutMs: 120_000 }),
        ) as { id: string }

        await untilShown(w, id, evidence, "the first execution completed", () => completed(w, id) === 1)
        expect((await a.argv(id)).includes("--prompt-interactive"), `argv: ${await a.argv(id)}`)
        await w.ok(["send", id, "--", PONG(2)], { cwd: a.repo })
        await untilShown(w, id, evidence, "the typed message completed", () => completed(w, id) === 2)
        expect((await a.screen(id)).includes("PONG-AGY-2"), `agy's screen: ${(await a.screen(id)).slice(-800)}`)
        await a.core!.hc("kill", a.terminalOf(id))
        await until(
          "the session exited",
          () => row<{ e: number | null }>(w, `SELECT exited_at AS e FROM ${SESSIONS} s WHERE id = ?`, id)?.e != null,
          60_000,
        )
        await w.ok(
          [
            "send",
            id,
            "--",
            "What word did I ask you to remember? Reply with exactly: WORD-<the word>. Run no command and use no tool.",
          ],
          { cwd: a.repo },
        )
        await untilShown(w, id, evidence, "the resumed execution completed", () => completed(w, id) === 3)
        const resumed = await a.screen(id)
        expect(resumed.includes("WORD-COBALT-PINE"), `the resumed agy lost the word: ${resumed.slice(-800)}`)
      } finally {
        await a.close()
      }
    },
  },
  {
    id: "H12",
    tier: "agent",
    title:
      "agy (real) as the entry session on herdr: a message sent while it is idle is typed into agy and completes as its execution; a draft left in its input box is cleared and a message sent then arrives alone; a prompt typed in the pane opens an execution, and a message sent while it works waits for its Stop",
    run: async (w) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
      const a = await agyWorld(w, "herdr", "agy-entry", "agy")

      try {
        const entry = await a.entryIdle()

        const settled = () =>
          (row<{ n: number }>(
            w,
            "SELECT (SELECT count(*) FROM inbox WHERE recipient_session_id = ?1 AND status IN ('pending', 'delivering')) + (SELECT count(*) FROM execution WHERE session_id = ?1 AND outcome IS NULL) AS n",
            entry,
          )?.n ?? 1) === 0

        await until("the entry's own first task completed", settled, 300_000)

        const answered = async <A>(send: () => Promise<A>) => {
          const done = completed(w, entry)
          await send()
          await until("the message's execution completed", () => completed(w, entry) > done && settled(), 300_000)
        }

        await answered(() => w.ok(["send", entry, "--", PONG(1)], { cwd: a.repo }))

        await a.typeText(entry, "a draft the user left H12-DRAFT")
        await Bun.sleep(1_500)
        const before = a.executions(entry).length
        await answered(() => w.ok(["send", entry, "--", PONG(2)], { cwd: a.repo }))
        const afterDraft = await a.screen(entry)
        expect(!afterDraft.includes("H12-DRAFT"), `the draft was not cleared:\n${afterDraft}`)
        expect(a.executions(entry).length === before + 1, `executions: ${JSON.stringify(a.executions(entry))}`)

        const handed = rows<{ content: string }>(
          w,
          "SELECT content FROM inbox WHERE recipient_session_id = ? AND recipient_execution_id = ?",
          entry,
          a.executions(entry).at(-1)!.id,
        )

        expect(handed.length === 1 && handed[0]!.content.includes("PONG-AGY-2"), `handed: ${JSON.stringify(handed)}`)

        await a.typeText(entry, "Run this shell command exactly: sleep 20. Then reply with exactly: H12-SLEPT")
        await Bun.sleep(1_000)
        await a.pressKeys(entry, ["enter"])
        await until(
          "the typed prompt's execution open",
          async () => (await a.listed(entry))?.executionState === "open",
          60_000,
        )
        const working = a.executions(entry).length
        const done = completed(w, entry)
        await w.ok(["send", entry, "--", PONG(3)], { cwd: a.repo })
        await Bun.sleep(5_000)
        expect(
          a.executions(entry).length === working,
          `a message was typed while the typed prompt ran: ${JSON.stringify(a.executions(entry))}`,
        )
        await until("the typed prompt and the message both completed", () => completed(w, entry) >= done + 2, 300_000)
        const all = a.executions(entry)
        expect(all[working - 1]?.outcome === "completed", `the typed prompt's execution: ${JSON.stringify(all)}`)
      } finally {
        await a.close()
      }
    },
  },
  {
    id: "H14",
    tier: "agent",
    title:
      "agy (real): a tool call vibest's guard refuses does not run (curl targeting vibest.sock); the session goes on and writes its marker",
    run: async (w, evidence) => {
      const binary = await signedIn(w)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
      const ran = path.join(w.root, "h14-ran.txt")
      const marker = path.join(w.root, "h14-marker.txt")
      const task = `Run exactly this shell command with your command tool: curl --unix-socket "$VIBEST_HOME/vibest.sock" http://vibest/api/hook/ready > ${ran}. Whatever happens, then run exactly this shell command: echo done > ${marker}. Then reply with exactly: H14-DONE`
      await withSession(w, "agy", [], task, async ({ id }) => {
        await untilShown(w, id, evidence, "the execution completed", () => completed(w, id) === 1)

        const exists = (file: string) =>
          fs.stat(file).then(
            () => true,
            () => false,
          )

        expect(!(await exists(ran)), "the refused vibest-http.sock command ran")
        expect(await exists(marker), "the session did not go on to write its marker")
      })
    },
  },
  {
    id: "H13",
    tier: "agent",
    title:
      "agy (real) loads vibest's plugin for the session only: its /hooks and /skills name vibest's hooks and skills, the shipped plugin validates, and the launch passes no --settings",
    run: async (w) => {
      const binary = await signedIn(w)
      const plugin = path.join(harnesses, "agy", ".agents", "plugins", "vibest")
      const valid = await w.run(w.repository, [binary, "plugin", "validate", plugin, "--strict", "--json"])
      expect(valid.code === 0, `agy plugin validate: ${valid.stdout}${valid.stderr}`)
      await w.stopDaemon()
      await useAgyBinary(w, binary)
      const a = await agyWorld(w, "herdr", "agy-h13", "agy")

      try {
        const entry = await a.entryIdle()
        const argv = await a.argv(entry)
        expect(argv.includes("--add-dir") && !argv.includes("--settings"), `agy's argv: ${argv}`)
        await a.typeText(entry, "/hooks")
        await a.pressKeys(entry, ["enter"])
        await until("agy's /hooks", async () => /PreInvocation\s.*1 hook/.test(await a.screen(entry)), 30_000)
        const hooks = await a.screen(entry)
        expect(/Stop\s.*1 hook/.test(hooks), `agy's /hooks:\n${hooks}`)
        await a.pressKeys(entry, ["esc"])
        await Bun.sleep(1_000)
        await a.typeText(entry, "/skills")
        await a.pressKeys(entry, ["enter"])
        await until("agy's /skills", async () => (await a.screen(entry)).includes("vibest:delegate"), 30_000)
        expect(completed(w, entry) === 0, "a model turn ran")
      } finally {
        await a.close()
      }
    },
  },
]

export default checks
