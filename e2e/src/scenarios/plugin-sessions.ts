import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, reply } from "../fake-model.ts"
import { expect, rows, until, type World } from "../world.ts"
import { configurePlugins } from "../world/plugins.ts"
import {
  entryIdOf,
  inboxRows,
  lastExecution,
  needs,
  piEntry,
  recordingModel,
  runSub,
  seen,
  sendingModel,
} from "./delivery.ts"
import { dropHerdrSession } from "./inbox.ts"

const sessionProbe = (log: string) => `import fs from "node:fs"
import { Plugin } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"
const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(line) + "\\n")
export default Plugin.define({
  id: "session-probe",
  effect: (ctx) =>
    ctx.event.subscribe({ types: ["session.execution.succeeded", "session.archived"] }).pipe(
      Stream.runForEach((fact) =>
        Effect.gen(function* () {
          const id = fact.sessionId
          if (fact.type === "session.archived") {
            yield* ctx.session.send({ to: id, message: "after-archive", request: \`after:\${id}\` })
            return
          }
          const got = yield* ctx.session.get(id)
          const listed = (yield* ctx.session.list()).some((s) => s.id === id)
          log({ id, execution: fact.data.executionId, got, listed })
          if (got === undefined || got.parentId === null) return
          for (const _ of [1, 2])
            yield* ctx.session.send({
              to: got.parentId,
              message: \`probe-\${id}-\${fact.data.executionId}\`,
              request: \`probe:\${id}:\${fact.data.executionId}\`,
            })
        }).pipe(Effect.catch((e) => Effect.sync(() => log({ failed: String(e) })))),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    ),
})
`

type Probed = {
  id: string
  execution: number
  listed: boolean
  got?: {
    title: string
    parentId: string | null
    latest: { execution: number; outcome: string; sent: number; endedAt: number } | null
  }
}

const probedLines = (file: string) =>
  fs.readFile(file, "utf8").then(
    (t) =>
      t
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Probed),
    () => [] as Array<Probed>,
  )

const pluginRows = (w: World, recipient: string) =>
  rows<{ content: string; status: string }>(
    w,
    `SELECT content, status FROM inbox WHERE recipient_session_id = ? AND sender_plugin = 'session-probe' ORDER BY id`,
    recipient,
  )

const pluginSessionChecks: ReadonlyArray<Check> = [
  {
    id: "G17",
    title:
      "a plugin's ctx.session.get and list show a subagent's parent and latest execution with how many messages it sent (0 when it only replied, 1 after one vibest send); ctx.session.send queues one message from the plugin per request, which the entry session's model sees naming the plugin, and one to an archived subagent goes to the session that started it",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      const quietModel = recordingModel(() => reply("done-quiet\nstatus: completed"))
      let entryId = ""
      const sending = sendingModel(() => entryId, "hello-probe")
      const log = path.join(w.root, "session-probe.log")
      let session = ""

      try {
        const m = await piEntry(w, "session-probe", entryModel.url)
        session = m.session
        entryId = entryIdOf(w)
        const file = path.join(w.vibestHome, "plugins", "session-probe.ts")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(`${file}.tmp`, sessionProbe(log))
        await fs.rename(`${file}.tmp`, file)
        await until("the probe plugin active", async () =>
          (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
            (p) => p.id === "session-probe" && p.status === "active",
          ),
        )
        const quiet = await runSub(w, m.repo, session, quietModel.url, "pi-probe-quiet", "reply only")
        const sender = await runSub(w, m.repo, session, sending.url, "pi-probe-sender", "send to the entry session")

        const probed = async (id: string) =>
          (await probedLines(log)).find((line) => line.id === id && line.got?.latest?.execution === line.execution)

        await until(
          "both subagents probed",
          async () => (await probed(quiet)) !== undefined && (await probed(sender)) !== undefined,
          120_000,
        )
        const failed = (await probedLines(log)).filter((line) => "failed" in line)
        expect(failed.length === 0, `the probe failed: ${JSON.stringify(failed)}`)

        for (const [id, sent] of [
          [quiet, 0],
          [sender, 1],
        ] as const) {
          const line = (await probed(id))!
          expect(
            line.listed &&
              line.got?.parentId === entryId &&
              line.got.title !== "" &&
              line.got.latest?.outcome === "completed" &&
              line.got.latest.sent === sent,
            `${id} probed as ${JSON.stringify(line)}; expected parent ${entryId} and ${sent} sent`,
          )
        }

        await until(
          "the plugin's messages delivered",
          () =>
            [quiet, sender].every((id) =>
              pluginRows(w, entryId).some((r) => r.content.includes(`probe-${id}-`) && r.status === "delivered"),
            ),
          60_000,
        )

        for (const id of [quiet, sender]) {
          const execution = (await probed(id))!.execution
          const of = pluginRows(w, entryId).filter((r) => r.content.includes(`probe-${id}-${execution}`))
          expect(
            of.length === 1,
            `${of.length} plugin messages about ${id}'s execution ${execution}: ${JSON.stringify(of)}`,
          )
        }

        await until(
          "the entry session's model saw the plugin's message",
          () => seen(entryModel).includes("<plugin>session-probe</plugin>"),
          60_000,
        )
        await w.ok(["archive", quiet], { cwd: m.repo, timeoutMs: 60_000 })
        await until(
          "the message to the archived subagent reached the entry session",
          () => pluginRows(w, entryId).some((r) => r.content.includes("after-archive")),
          60_000,
        )
        expect(
          inboxRows(w, "recipient_session_id = ? AND content LIKE '%after-archive%'", quiet) === 0,
          "the message was queued for the archived subagent",
        )
      } finally {
        entryModel.stop()
        quietModel.stop()
        sending.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

const REMINDER = "vibest.report-reminder"

const reminders = (w: World, recipient: string, about: string) =>
  rows<{ content: string; status: string }>(
    w,
    `SELECT content, status FROM inbox WHERE recipient_session_id = ? AND sender_plugin = 'vibest.report-reminder' AND content LIKE ? ORDER BY id`,
    recipient,
    `%(${about})%`,
  )

const completed = (w: World, id: string) =>
  until(`${id} completed`, () => lastExecution(w, id)?.status === "completed", 90_000)

const reminderChecks: ReadonlyArray<Check> = [
  {
    id: "G18",
    title:
      "the shipped report-reminder plugin, once its id vibest.report-reminder is added to vibest.json, sends a subagent's creator one message from the plugin when an execution completes without the subagent sending; one that sent gets none; nothing is sent while it is not loaded, and an execution that ended then is reported once when it loads and once across a vibestd restart",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      const quietModel = recordingModel(() => reply("done-quiet\nstatus: completed"))
      let entryId = ""
      const sending = sendingModel(() => entryId, "hello-reminder")
      let session = ""

      const active = async (on: boolean) =>
        until(
          `report-reminder ${on ? "active" : "unloaded"}`,
          async () =>
            (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
              (p) => p.id === REMINDER && p.status === "active",
            ) === on,
        )

      try {
        const m = await piEntry(w, "reminder", entryModel.url)
        session = m.session
        entryId = entryIdOf(w)
        const before = await runSub(w, m.repo, session, quietModel.url, "pi-reminder-before", "reply only")
        await completed(w, before)
        await Bun.sleep(2_000)
        expect(reminders(w, entryId, before).length === 0, "a reminder was sent without the plugin")

        await configurePlugins(w, (list) => [...list, REMINDER])
        await active(true)
        await until(
          "the execution that ended before it loaded reported",
          () => reminders(w, entryId, before).length > 0,
          60_000,
        )

        const quiet = await runSub(w, m.repo, session, quietModel.url, "pi-reminder-quiet", "reply only")
        const sender = await runSub(w, m.repo, session, sending.url, "pi-reminder-sender", "send to the entry session")
        await completed(w, sender)
        await until("the quiet subagent reported", () => reminders(w, entryId, quiet).length > 0, 60_000)
        await until(
          "the entry session's model saw the reminder",
          () => seen(entryModel).includes(`<plugin>${REMINDER}</plugin>`),
          60_000,
        )

        await configurePlugins(w, (list) => list.filter((p) => p !== REMINDER))
        await active(false)
        const gap = await runSub(w, m.repo, session, quietModel.url, "pi-reminder-gap", "reply only")
        await completed(w, gap)
        await w.stopDaemon()
        await configurePlugins(w, (list) => [...list, REMINDER])
        await w.ok(["daemon"], { cwd: m.repo })
        await active(true)
        await until(
          "the execution that ended while it was unloaded reported",
          () => reminders(w, entryId, gap).length > 0,
          60_000,
        )
        await Bun.sleep(2_000)

        for (const [id, count] of [
          [before, 1],
          [quiet, 1],
          [gap, 1],
          [sender, 0],
        ] as const)
          expect(
            reminders(w, entryId, id).length === count,
            `${reminders(w, entryId, id).length} reminders about ${id}, expected ${count}: ${JSON.stringify(reminders(w, entryId, id))}`,
          )
        expect(
          inboxRows(w, `sender_plugin = '${REMINDER}' AND recipient_session_id <> ?`, entryId) === 0,
          "a reminder went to a session other than the entry session",
        )
      } finally {
        entryModel.stop()
        quietModel.stop()
        sending.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

const IDLE_STOP = "vibest.idle-stop"

const idleStopChecks: ReadonlyArray<Check> = [
  {
    id: "G20",
    title:
      "the shipped idle-stop plugin, once vibest.idle-stop is added to vibest.json with a short idleMinutes, stops a subagent idle that long, recorded as stopped by the plugin, and sends its creator one message from the plugin saying how to resume or archive it; a subagent with an open execution and the entry session keep running",
    run: async (w) => {
      needs()
      const entryModel = recordingModel(() => reply("ok"))
      const quietModel = recordingModel(() => reply("done-quiet\nstatus: completed"))
      const busyModel = heldModel()
      let session = ""

      const processOf = (id: string) =>
        rows<{ reason: string | null }>(
          w,
          "SELECT end_reason AS reason FROM process WHERE session_id = ? ORDER BY id DESC LIMIT 1",
          id,
        )[0]

      const idleMessages = (recipient: string, about: string) =>
        rows<{ content: string; status: string }>(
          w,
          "SELECT content, status FROM inbox WHERE recipient_session_id = ? AND sender_type = 'plugin' AND sender_plugin = ? AND content LIKE ?",
          recipient,
          IDLE_STOP,
          `%(${about})%`,
        )

      try {
        const m = await piEntry(w, "idle-stop", entryModel.url)
        session = m.session
        const entryId = entryIdOf(w)
        const quiet = await runSub(w, m.repo, session, quietModel.url, "pi-idle-quiet", "reply only")
        const busy = await runSub(w, m.repo, session, busyModel.url, "pi-idle-busy", ask("g19busy"))
        await completed(w, quiet)
        await until("the busy subagent's model call held", () => busyModel.held() > 0, 60_000)

        await configurePlugins(w, (list) => [...list, { package: IDLE_STOP, options: { idleMinutes: 0.05 } }])
        await until("the idle subagent stopped", () => processOf(quiet)?.reason === "stopped", 60_000)

        const by = rows<{ data: string }>(
          w,
          "SELECT data FROM event WHERE aggregate = ? AND type = 'process.ended' ORDER BY seq DESC LIMIT 1",
          quiet,
        ).map((r) => (JSON.parse(r.data) as { by?: unknown }).by)[0]

        expect(
          JSON.stringify(by) === JSON.stringify({ type: "plugin", plugin: IDLE_STOP }),
          `stopped by ${JSON.stringify(by)}`,
        )
        await until(
          "the entry session's model saw the idle-stop message",
          () => seen(entryModel).includes(`<plugin>${IDLE_STOP}</plugin>`) && seen(entryModel).includes(quiet),
          60_000,
        )
        await Bun.sleep(5_000)
        const told = idleMessages(entryId, quiet)

        expect(
          told.length === 1 &&
            told[0]!.content.includes("was idle for 0.05 minutes and was stopped") &&
            told[0]!.content.includes("vibest send") &&
            told[0]!.content.includes("vibest archive"),
          `messages about ${quiet}: ${JSON.stringify(told)}`,
        )
        expect(processOf(busy)?.reason === null, `the busy subagent's process ended ${processOf(busy)?.reason}`)
        expect(processOf(entryId)?.reason === null, `the entry session's process ended ${processOf(entryId)?.reason}`)
      } finally {
        entryModel.stop()
        quietModel.stop()
        busyModel.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default [...pluginSessionChecks, ...reminderChecks, ...idleStopChecks]
