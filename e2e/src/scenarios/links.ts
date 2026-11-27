import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { piDir, reply, text, toolCall } from "../fake-model.ts"
import { binary, expect, row, until, type World } from "../world.ts"
import { needs, piEntry, recordingModel, seen } from "./delivery.ts"
import { dropHerdrSession } from "./inbox.ts"

const ORDER = /RUN: ([\s\S]*?) :NUR/

const orderedModel = (name: string) =>
  recordingModel((messages) => {
    const last = messages.at(-1)

    if (last?.role === "tool") return reply(`done-${name}`)
    const order = ORDER.exec(text(last))

    return order === null ? reply(`ready-${name}`) : toolCall(`call-${messages.length}`, "bash", { command: order[1]! })
  })

type Ordered = ReturnType<typeof orderedModel>

const inboxFrom = (w: World, sender: string) =>
  row<{ n: number }>(
    w,
    "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND sender_type != 'vibest' AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = inbox.recipient_session_id AND s.message_id = inbox.id)",
    sender,
  )?.n ?? 0

const S67: Check = {
  id: "S67",
  title:
    "vibest run --with links sessions at spawn and names the linked target in the system prompt; vibest session link and unlink control directed messaging between siblings; unlinked and archived targets are refused",
  run: async (w) => {
    needs()
    const entryModel = recordingModel(() => reply("ok"))
    const models: Array<Ordered> = []
    let session = ""

    const start = async (name: string, ...flags: Array<string>) => {
      const model = orderedModel(name)
      models.push(model)
      const dir = await piDir(w, `pi-link-${name}`, model.url)

      const out = await w.okViaEntry(
        ["run", ...flags, "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${dir}`, "--", "wait"],
        { cwd: repo, timeoutMs: 90_000 },
      )

      const { id } = JSON.parse(out) as { id: string }
      await until(`${name} answered`, () => seen(model).length > 0 && model.requests.length > 0, 90_000)

      return { id, model }
    }

    let order = 0

    const tell = async (member: { id: string }, command: string) => {
      const file = path.join(w.root, `link-order-${++order}.txt`)
      await w.okViaEntry(["send", member.id, "--", `RUN: { ${command}; } > ${file} 2>&1; echo END >> ${file} :NUR`], {
        cwd: repo,
      })
      await until(
        `order ${order} to ${member.id} ran`,
        async () => (await fs.readFile(file, "utf8").catch(() => "")).includes("END"),
        90_000,
      )

      return (await fs.readFile(file, "utf8")).replace(/END\s*$/, "").trim()
    }

    let repo = ""

    try {
      const m = await piEntry(w, "links", entryModel.url)
      session = m.session
      repo = m.repo

      const a = await start("a")
      const b = await start("b", "--with", a.id.slice(0, 8))
      const c = await start("c")

      const system = text(b.model.requests[0]!.find((x) => x.role === "system" || x.role === "developer"))
      expect(
        system.includes(a.id.slice(0, 8)) && !system.includes(a.id),
        `b's system prompt should mention linked session ${a.id.slice(0, 8)}: ${system}`,
      )

      const toSelf = await tell(a, `${binary} send ${a.id.slice(0, 8)} -- to-myself`)
      expect(toSelf.includes("Forbidden") && toSelf.includes("does not send to itself"), `a send to oneself: ${toSelf}`)
      expect(inboxFrom(w, a.id) === 0, "a's send to itself was queued")

      await tell(a, `${binary} send ${b.id.slice(0, 8)} -- hello-from-a`)
      await until("b got a's message", () => seen(b.model).includes("hello-from-a"), 90_000)
      const got = text(b.model.requests.find((r) => text(r.at(-1)).includes("hello-from-a"))!.at(-1))
      expect(
        got.includes("<vibest-agent-message>") && got.includes(`<session-id>${a.id.slice(0, 8)}</session-id>`),
        `b saw: ${got}`,
      )

      const unlinked = await tell(c, `${binary} send ${a.id.slice(0, 8)} -- not-linked`)
      expect(unlinked.includes("Forbidden") && unlinked.includes("not linked"), `unlinked c -> a: ${unlinked}`)
      expect(inboxFrom(w, c.id) === 0, "c's refused send was queued")

      await w.okViaEntry(["session", "link", c.id.slice(0, 8), "--to", a.id.slice(0, 8)], { cwd: repo })
      await tell(c, `${binary} send ${a.id.slice(0, 8)} -- linked-now`)
      await until("a got c's message", () => seen(a.model).includes("linked-now"), 90_000)

      await w.okViaEntry(["session", "unlink", c.id.slice(0, 8), "--to", a.id.slice(0, 8)], { cwd: repo })
      const afterUnlink = await tell(c, `${binary} send ${a.id.slice(0, 8)} -- unlinked-now`)
      expect(
        afterUnlink.includes("Forbidden") && afterUnlink.includes("not linked"),
        `after unlink c -> a: ${afterUnlink}`,
      )

      await w.okViaEntry(["archive", b.id], { cwd: repo, timeoutMs: 90_000 })
      const before = inboxFrom(w, a.id)
      const archived = await tell(a, `${binary} send ${b.id} -- to-the-archived`)
      expect(archived.includes("was archived"), `send to archived b: ${archived}`)
      expect(inboxFrom(w, a.id) === before, "the send to archived b was queued for someone")
    } finally {
      entryModel.stop()

      for (const model of models) model.stop()
      await dropHerdrSession(w, session)
    }
  },
}

export default [S67]
