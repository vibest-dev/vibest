import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { piDir, reply, text, toolCall } from "../fake-model.ts"
import { binary, expect, row, until, type World } from "../world.ts"
import { entryIdOf, needs, piEntry, recordingModel, seen } from "./delivery.ts"
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
    "vibest run --team pi (a bare --team before the harness) makes a team whose id the run prints and runs Pi, --team <id> adds two more; the three list each other with vibest ls --team and one sends to another, which arrives from the real sender; another team, a non-member, another creator's new team, a second session adding to the team, an unknown team id, a member's own child, a send to an archived teammate, ls --team from outside the team and adding to a team whose members have all ended are each refused or left out; its creator lists it",
  run: async (w) => {
    needs()
    const entryModel = recordingModel(() => reply("ok"))
    const models: Array<Ordered> = []
    let session = ""

    const start = async (name: string, ...flags: Array<string>) => {
      const model = orderedModel(name)
      models.push(model)
      const dir = await piDir(w, `pi-team-${name}`, model.url)

      const out = await w.okViaEntry(
        ["run", ...flags, "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${dir}`, "--", "wait"],
        { cwd: repo, timeoutMs: 90_000 },
      )

      const { id, team } = JSON.parse(out) as { id: string; team?: string }
      await until(`${name} answered`, () => seen(model).length > 0 && model.requests.length > 0, 90_000)

      return { id, team, model }
    }

    let order = 0

    const tell = async (member: { id: string }, command: string) => {
      const file = path.join(w.root, `team-order-${++order}.txt`)
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
      const m = await piEntry(w, "teams", entryModel.url)
      session = m.session
      repo = m.repo
      const entry = entryIdOf(w)

      const a = await start("a", "--team")
      const web = a.team!
      expect(/^t-[0-9a-f]{4}$/.test(web), `vibest run --team pi printed team ${web}`)
      const b = await start("b", "--team", web)
      const c = await start("c", "--team", web)
      expect(b.team === web && c.team === web, `--team ${web} printed ${b.team} and ${c.team}`)
      const ids = [a.id, b.id, c.id].sort()

      for (const member of [a, b, c]) {
        const listed = JSON.parse(await tell(member, `${binary} ls --team`)) as {
          team: string
          members: Array<{ id: string; startedBy: string | null; title: string; agent: string; status: string }>
        }

        expect(
          listed.team === web &&
            JSON.stringify(listed.members.map((x) => x.id).sort()) === JSON.stringify(ids) &&
            listed.members.every((x) => x.startedBy === entry && x.agent === "general" && x.title !== ""),
          `vibest ls --team from ${member.id}: ${JSON.stringify(listed)}`,
        )
      }

      const system = text(b.model.requests[0]!.find((x) => x.role === "system" || x.role === "developer"))
      expect(
        system.includes(`member of team ${web}`) && system.includes("vibest ls --team"),
        `b's system prompt: ${system}`,
      )

      const toSelf = await tell(a, `${binary} send ${a.id} -- to-myself`)
      expect(toSelf.includes("Forbidden") && toSelf.includes("does not send to itself"), `a send to oneself: ${toSelf}`)
      expect(inboxFrom(w, a.id) === 0, "a's send to itself was queued")

      await tell(a, `${binary} send ${b.id} -- hello-from-a`)
      await until("b got a's message", () => seen(b.model).includes("hello-from-a"), 90_000)
      const got = text(b.model.requests.find((r) => text(r.at(-1)).includes("hello-from-a"))!.at(-1))
      expect(got.includes("<vibest-agent-message>") && got.includes(a.id), `b saw: ${got}`)
      expect(
        (row<{ n: number }>(
          w,
          "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND recipient_session_id = ? AND sender_type != 'vibest' AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = inbox.recipient_session_id AND s.message_id = inbox.id)",
          a.id,
          b.id,
        )?.n ?? 0) === 1,
        "a's send to b is not one inbox row from a",
      )

      const other = await start("other", "--team")
      const loner = await start("loner")
      const strangerDir = await piDir(w, "pi-team-stranger", loner.model.url)

      const stranger = JSON.parse(
        await tell(loner, `${binary} run pi --team --env PI_CODING_AGENT_DIR=${strangerDir} -- wait`),
      ) as { id: string; team: string }

      expect(
        other.team !== undefined && new Set([web, other.team, stranger.team]).size === 3,
        `three bare --team gave teams ${web}, ${other.team}, ${stranger.team}`,
      )
      const toStranger = await tell(a, `${binary} send ${stranger.id} -- not-a-teammate`)
      expect(
        toStranger.includes("Forbidden") && toStranger.includes("not in your team"),
        `send from a to another creator's team: ${toStranger}`,
      )

      for (const sender of [other, loner]) {
        const refused = await tell(sender, `${binary} send ${a.id} -- not-a-teammate`)
        expect(
          refused.includes("Forbidden") && refused.includes("not in your team"),
          `send to a from ${sender.id}: ${refused}`,
        )
        expect(inboxFrom(w, sender.id) === 0, `${sender.id}'s refused send was queued`)
      }

      const peeked = await tell(loner, `${binary} ls --team ${web}`)
      expect(
        peeked.includes("Forbidden") && peeked.includes("only for the session that created it and its members"),
        `vibest ls --team ${web} from a session outside it: ${peeked}`,
      )

      const byCreator = JSON.parse(await w.okViaEntry(["ls", "--team", web], { cwd: repo })) as {
        members: Array<{ id: string }>
      }

      expect(
        JSON.stringify(byCreator.members.map((x) => x.id).sort()) === JSON.stringify(ids),
        `vibest ls --team ${web} from its creator: ${JSON.stringify(byCreator)}`,
      )

      const childDir = await piDir(w, "pi-team-child", other.model.url)
      const taken = await tell(other, `${binary} run pi --team ${web} --env PI_CODING_AGENT_DIR=${childDir} -- wait`)
      expect(taken.includes("Forbidden") && taken.includes(`owned by ${entry}`), `a second owner for ${web}: ${taken}`)
      const held = new Set([web, other.team, stranger.team])
      const nobody = ["t-0000", "t-0001", "t-0002", "t-0003"].find((id) => !held.has(id))!

      const unknown = await tell(
        other,
        `${binary} run pi --team ${nobody} --env PI_CODING_AGENT_DIR=${childDir} -- wait`,
      )

      expect(unknown.includes("Forbidden") && unknown.includes(`no team ${nobody}`), `an unknown team id: ${unknown}`)

      const child = JSON.parse(await tell(a, `${binary} run pi --env PI_CODING_AGENT_DIR=${childDir} -- wait`)) as {
        id: string
      }

      const after = JSON.parse(await tell(b, `${binary} ls --team ${web}`)) as { members: Array<{ id: string }> }
      expect(
        JSON.stringify(after.members.map((x) => x.id).sort()) === JSON.stringify(ids),
        `${web} after a started ${child.id} and another session tried to join: ${JSON.stringify(after)}`,
      )

      await w.okViaEntry(["archive", c.id], { cwd: repo, timeoutMs: 90_000 })
      const before = inboxFrom(w, a.id)
      const archived = await tell(a, `${binary} send ${c.id} -- to-the-archived`)
      expect(archived.includes("was archived"), `send to archived c: ${archived}`)
      expect(inboxFrom(w, a.id) === before, "the send to archived c was queued for someone")
      const listedNow = JSON.parse(await tell(a, `${binary} ls --team`)) as { members: Array<{ id: string }> }
      expect(!listedNow.members.some((x) => x.id === c.id), `archived c is still listed: ${JSON.stringify(listedNow)}`)

      for (const member of [a, b]) await w.okViaEntry(["archive", member.id], { cwd: repo, timeoutMs: 90_000 })
      const ended = await w.viaEntry(["run", "pi", "--team", web, "--session", session, "--", "wait"], { cwd: repo })
      expect(
        ended.code !== 0 && ended.stdout.includes(`team ${web} has ended`),
        `--team ${web} after its last member was archived: ${ended.stdout}`,
      )
    } finally {
      entryModel.stop()

      for (const model of models) model.stop()
      await dropHerdrSession(w, session)
    }
  },
}

export default [S67]
