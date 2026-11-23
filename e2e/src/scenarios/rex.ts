import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"

import { Predicate, type Schema } from "effect"

import { commandOf, note } from "../../../tools/reap.ts"
import type { Check } from "../check.ts"
import { creatorIn, type Message, piDir, reply, sendOrReply, text } from "../fake-model.ts"
import { alive, expect, row, rows, SESSIONS, Skip, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"
import { recordingModel } from "./delivery.ts"
import { project } from "./inbox.ts"

const MIN_API_REVISION = 18

const FLAVOR = "com.superlogical.terminal.shell"

const candidates = () => [
  process.env.REX_BIN,
  Bun.which("rex") ?? undefined,
  "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
  "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
]

const revisionOf = (bin: string) =>
  Number(
    /api: revision (\d+)/.exec(
      Bun.spawnSync([bin, "version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString(),
    )?.[1] ?? 0,
  )

const rexBinary = () => {
  const found = candidates().find(
    (bin): bin is string =>
      bin !== undefined && bin !== "" && fs.existsSync(bin) && revisionOf(bin) >= MIN_API_REVISION,
  )

  if (found === undefined) throw new Skip("rex binary not installed")

  return found
}

type View = {
  windows: Array<{ window_id: string; layers: Array<{ blocks: Array<{ block_id: string }> }> }>
}

export const rexServer = async (w: World, blockEnv: Record<string, string>) => {
  const bin = rexBinary()
  w.ownRuntimes.add("rex")
  const root = await fsPromises.mkdtemp("/tmp/vbrex-")
  const socket = path.join(root, "server.sock")
  await fsPromises.mkdir(path.join(root, "state"))
  await fsPromises.mkdir(path.join(root, "run"))
  await fsPromises.writeFile(path.join(root, "init.lua"), "")
  const env = { ...blockEnv, REX_SOCKET: socket }

  const server = Bun.spawn(
    [
      bin,
      "server",
      "run",
      "--listen",
      `unix://${socket}`,
      "--state-dir",
      path.join(root, "state"),
      "--restore=false",
      "--config",
      path.join(root, "init.lua"),
    ],
    {
      env: w.env({ ...env, REX_RUNTIME_DIR: path.join(root, "run") }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(path.join(w.root, "rex-server.log")),
    },
  )

  note(server.pid, commandOf(server.pid).trim(), w.root, w.root)
  await until("the Rex server to listen", () => fs.existsSync(socket), 20_000)

  const rex = (args: ReadonlyArray<string>, stdin?: string) =>
    w.run(w.root, [bin, "--autostart=false", "-S", `unix://${socket}`, ...args], {
      env,
      ...(stdin !== undefined && { stdin }),
    })

  const api = async <A>(method: string, payload: Schema.JsonObject) => {
    const r = await rex(["api", "call", method, JSON.stringify(payload)])
    expect(r.code === 0, `rex api call ${method}: ${r.stderr}${r.stdout}`)

    return JSON.parse(r.stdout) as A
  }

  return {
    env,
    socket,
    rex,
    api,
    view: (sessionId: string) => api<View>("session.view", { session_id: sessionId }),
    blockGone: async (terminal: string) => {
      const [sessionId, blockId] = terminal.split("/")

      const r = await rex([
        "api",
        "call",
        "block.method",
        JSON.stringify({ session_id: sessionId, block_id: blockId, method: "process", args: {} }),
      ])

      return r.code !== 0 && /not_found/.test(r.stderr + r.stdout)
    },
    screens: async () => {
      const shown: Array<string> = []
      const listed = await api<{ sessions: Array<{ session_id: string; label: string }> | null }>("session.list", {})

      for (const session of listed.sessions ?? [])
        for (const win of (await api<View>("session.view", { session_id: session.session_id })).windows)
          for (const layer of win.layers)
            for (const block of layer.blocks) {
              const captured = await rex(["capture", "-s", session.session_id, "-b", block.block_id])
              shown.push(`--- ${session.label} ${session.session_id}/${block.block_id}\n${captured.stdout.trim()}`)
            }

      return shown.join("\n")
    },
    screen: async (terminal: string) => {
      const [sessionId, blockId] = terminal.split("/")

      return (await rex(["capture", "-s", sessionId!, "-b", blockId!])).stdout
    },
    stop: async () => {
      await rex(["server", "stop"])

      for (const deadline = Date.now() + 10_000; alive(server.pid) && Date.now() < deadline;) await Bun.sleep(100)

      if (alive(server.pid)) server.kill("SIGKILL")
      await server.exited
      await fsPromises.rm(root, { recursive: true, force: true })
    },
  }
}

type Rex = Awaited<ReturnType<typeof rexServer>>

const shSingle = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

export const entryInRex = async (w: World, rex: Rex, repo: string, flags: ReadonlyArray<string>) => {
  const created = await rex.api<{ session_id: string; initial_windows: Array<{ block_ids: Array<string> }> }>(
    "session.create",
    {
      label: "entry",
      initial_windows: [
        { window_label: "entry", layout: { block: { flavor: FLAVOR, label: "entry", options: { cwd: repo } } } },
      ],
    },
  )

  const terminal = `${created.session_id}/${created.initial_windows[0]!.block_ids[0]!}`
  const [sessionId, blockId] = terminal.split("/") as [string, string]
  await until("the Rex block's shell", async () => /\S/.test(await rex.screen(terminal)), 30_000)

  const typed = await rex.rex(
    ["send", "-s", sessionId, "-b", blockId],
    `cd ${shSingle(repo)} && vibest --harness pi ${flags.map(shSingle).join(" ")}\r`,
  )

  expect(typed.code === 0, `rex send: ${typed.stderr}${typed.stdout}`)
  await until("the entry session", async () => (await w.entryOf(repo)) !== undefined, 120_000).catch(
    async (e: Error) => {
      throw new Error(`${e.message}; the Rex block shows:\n${await rex.screen(terminal)}`)
    },
  )

  return { id: (await w.entryOf(repo))!, terminal, sessionId }
}

type At = { kind?: string; id?: string }

export const runtimeOf = (w: World, id: string) =>
  JSON.parse(
    row<{ runtime: string | null }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, id)?.runtime ?? "{}",
  ) as At

const completed = (w: World, id: string) =>
  row<{ n: number }>(w, "SELECT count(*) AS n FROM execution WHERE session_id = ? AND outcome = 'completed'", id)?.n ??
  0

const windowOf = (view: View, blockId: string) =>
  view.windows.find((win) => win.layers.some((l) => l.blocks.some((b) => b.block_id === blockId)))?.window_id

const blockOf = (terminal: string | undefined) => terminal?.split("/")[1] ?? ""

const REPORT = Array.from({ length: 6 }, (_, i) => `rex-report-line-${i + 1}: inspected`).join("\n")

const childrenOf = (w: World, parent: string) =>
  rows<{ id: string }>(w, "SELECT id FROM session WHERE parent_session_id = ? ORDER BY created_at", parent).map(
    (r) => r.id,
  )

export const realPi = async (w: World, fakeUrl?: string) => {
  const agent = path.join(w.home, ".pi", "agent")

  const settings = JSON.parse(
    await fsPromises.readFile(path.join(agent, "settings.json"), "utf8").catch(() => "{}"),
  ) as Schema.JsonObject

  const provider = settings.defaultProvider
  const model = settings.defaultModel

  if (!Predicate.isString(provider) || !Predicate.isString(model))
    throw new Skip("the user's Pi names no default provider and model")

  const dir = await piShadow(
    path.join(w.root, "pi-real"),
    w.profile,
    fakeUrl === undefined ? {} : { fake: { baseUrl: fakeUrl } },
    { provider, model },
  )

  const providers = (Array.isArray(settings.packages) ? settings.packages : [])
    .filter(Predicate.isString)
    .filter((p) => p.startsWith("npm:") && p.endsWith("-provider"))
    .map((p) => path.join(agent, "npm", "node_modules", p.slice("npm:".length)))
    .filter((p) => fs.existsSync(p))

  const written = JSON.parse(await fsPromises.readFile(path.join(dir, "settings.json"), "utf8")) as Schema.JsonObject
  await fsPromises.writeFile(path.join(dir, "settings.json"), JSON.stringify({ ...written, packages: providers }))

  for (const name of ["auth.json", "cliproxyapi.json"])
    if (fs.existsSync(path.join(agent, name))) await fsPromises.symlink(path.join(agent, name), path.join(dir, name))

  return { dir, flags: ["--provider", provider, "--model", model] }
}

const CODEWORD = "REX-ORCHID-42"

const TELL = `Remember this codeword: ${CODEWORD}. Run no command and use no tool. Reply with exactly: NOTED`

const ASK =
  "What codeword did I ask you to remember? Run no command and use no tool. Reply with exactly: CODEWORD <the codeword>"

const PING = "Run no command and use no tool. Reply with exactly: REX-PONG-3"

const replyOf = (w: World, id: string) =>
  row<{ reply: string | null }>(
    w,
    "SELECT reply FROM execution WHERE session_id = ? AND outcome = 'completed' ORDER BY id DESC LIMIT 1",
    id,
  )?.reply ?? ""

type Process = { terminal: string | null; conversation: string | null; reason: string | null }

const processesOf = (w: World, id: string) =>
  rows<Process>(
    w,
    "SELECT terminal, harness_session_id AS conversation, end_reason AS reason FROM process WHERE session_id = ? ORDER BY id",
    id,
  )

const lifecycle = async (
  w: World,
  rex: Rex,
  input: {
    readonly entry: ReadonlyArray<string>
    readonly worker: ReadonlyArray<string>
    readonly timeoutMs: number
  },
) => {
  await w.daemon({ env: rex.env })
  const repo = await project(w, "rexlife")
  await w.ok(["--runtime", "rex", "--headless", "--harness", "pi", ...input.entry], {
    cwd: repo,
    env: rex.env,
    timeoutMs: 120_000,
  })
  await until("the entry session", async () => (await w.entryOf(repo)) !== undefined, 120_000)
  const entryId = (await w.entryOf(repo))!
  await until(
    "the entry session's harness",
    () => row<{ pid: number | null }>(w, `SELECT pid FROM ${SESSIONS} s WHERE id = ?`, entryId)?.pid != null,
    60_000,
  ).catch(async (e: Error) => {
    throw new Error(`${e.message}; Rex shows:\n${await rex.screens()}`)
  })
  const entryAt = runtimeOf(w, entryId)

  const listed = (await rex.api<{ sessions: Array<{ session_id: string; label: string }> }>("session.list", {}))
    .sessions

  const projectSession = listed.find((s) => s.label === path.basename(repo))?.session_id
  expect(
    entryAt.kind === "rex" && projectSession !== undefined && entryAt.id?.startsWith(`${projectSession}/`) === true,
    `the entry session started with --runtime rex runs at ${JSON.stringify(entryAt)}; Rex sessions ${JSON.stringify(listed)}`,
  )

  const id = (
    JSON.parse(
      await w
        .okViaEntry(["run", "pi", ...input.worker, "--title", "Remember a codeword", "--", TELL], {
          cwd: repo,
          asIs: true,
          timeoutMs: 120_000,
        })
        .catch(async (e: Error) => {
          throw new Error(
            `${e.message}; the entry's processes: ${JSON.stringify(processesOf(w, entryId))}; Rex shows:\n${await rex.screens()}`,
          )
        }),
    ) as { id: string }
  ).id

  const shown = async (e: Error) => {
    throw new Error(`${e.message}; its block:\n${await rex.screen(processesOf(w, id).at(-1)?.terminal ?? "")}`)
  }

  await until("the first execution completed", () => completed(w, id) === 1, input.timeoutMs).catch(shown)
  await until("Pi reported its conversation", () => processesOf(w, id).at(-1)?.conversation != null, 30_000)
  const first = processesOf(w, id).at(-1)!
  expect(runtimeOf(w, id).kind === "rex", `the session runs at ${JSON.stringify(runtimeOf(w, id))}`)

  await w.ok(["stop", id], { cwd: repo, env: rex.env })
  expect(processesOf(w, id).at(-1)?.reason === "stopped", `the process ended ${processesOf(w, id).at(-1)?.reason}`)
  await until("vibest stop closed its block", () => rex.blockGone(first.terminal!), 30_000)

  await w.ok(["send", id, "--", ASK], { cwd: repo, env: rex.env })
  await until("the resumed execution completed", () => completed(w, id) === 2, input.timeoutMs).catch(shown)
  const resumed = processesOf(w, id).at(-1)!
  expect(
    resumed.terminal !== null && resumed.terminal !== first.terminal && resumed.conversation === first.conversation,
    `resumed as ${JSON.stringify(resumed)}; before the stop ${JSON.stringify(first)}`,
  )
  expect(replyOf(w, id).includes(CODEWORD), `the resumed session lost the codeword: ${replyOf(w, id)}`)

  const before = await w.daemonPid()
  const restarted = await w.tty(["daemon", "restart"], "y\n", { cwd: repo, env: rex.env, timeoutMs: 120_000 })
  expect(restarted.code === 0, `vibest daemon restart exited ${restarted.code}: ${restarted.stdout}${restarted.stderr}`)
  const after = await w.daemonPid()
  expect(after !== undefined && after !== before, `vibestd was not replaced: ${before} -> ${after}`)

  await w.ok(["send", id, "--", PING], { cwd: repo, env: rex.env })
  await until("the execution after the restart completed", () => completed(w, id) === 3, input.timeoutMs).catch(shown)
  expect(replyOf(w, id).includes("REX-PONG-3"), `the reply after the restart: ${replyOf(w, id)}`)
  expect(
    processesOf(w, id).at(-1)?.terminal === resumed.terminal,
    `the session left its block over the restart: ${JSON.stringify(processesOf(w, id))}`,
  )

  await w.ok(["archive", id], { cwd: repo, env: rex.env })
  await until("archive closed its block", () => rex.blockGone(resumed.terminal!), 30_000)
}

const codewordModel = () =>
  recordingModel((messages: Array<Message>) => {
    const last = text(messages.at(-1))

    if (last.includes("REX-PONG-3")) return reply("REX-PONG-3")

    if (last.includes("What codeword"))
      return reply(messages.some((m) => text(m).includes(CODEWORD)) ? `CODEWORD ${CODEWORD}` : "CODEWORD unknown")

    return reply("NOTED")
  })

const checks: ReadonlyArray<Check> = [
  {
    id: "RX1",
    title:
      "Rex: vibest in a Rex block, without --runtime, starts the entry session in that block; vibest run from it opens the session in a new window of the same Rex session, and that session's multiline vibest send reaches the entry session whole; a send to it is its next execution; vibest run --share opens a split beside it in the same window; peek reads its block, doctor reports the Rex server, and archive closes the blocks",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")

      const model = recordingModel((messages: Array<Message>) => {
        const system = text(messages.find((m) => m.role === "system" || m.role === "developer"))

        if (creatorIn(system) === undefined) return reply("ok")
        const task = text(messages.find((m) => m.role === "user"))

        return task.includes("rex-share") ? reply("shared-ok") : sendOrReply(messages, REPORT)
      })

      const rex = await rexServer(w, { PI_CODING_AGENT_DIR: await piDir(w, "pi-rx1", model.url) })

      try {
        await w.daemon({ env: rex.env })
        const repo = await project(w, "rexshop")
        const entry = await entryInRex(w, rex, repo, [])
        const entryAt = runtimeOf(w, entry.id)
        expect(
          entryAt.kind === "rex" && entryAt.id === entry.terminal,
          `the entry session runs at ${JSON.stringify(entryAt)}, not in the Rex block ${entry.terminal}`,
        )

        const first = JSON.parse(
          await w.okViaEntry(["run", "pi", "--title", "Inspect repo in Rex", "--", "rex-inspect"], {
            cwd: repo,
            asIs: true,
            timeoutMs: 90_000,
          }),
        ) as { id: string }

        await until(
          "the entry session got the multiline report",
          () =>
            model.requests.some(
              (m) =>
                text(m.at(-1)).includes("vibest-agent-message") &&
                text(m.at(-1)).includes(JSON.stringify(REPORT).slice(1, -1)),
            ),
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(
            `${e.message}; the entry model saw: ${JSON.stringify(
              model.requests.map((m) => text(m.at(-1))),
              null,
              1,
            )}\nchild block:\n${await rex.screen(runtimeOf(w, first.id).id ?? "")}`,
          )
        })
        const childAt = runtimeOf(w, first.id)
        expect(
          childAt.kind === "rex" && childAt.id?.startsWith(`${entry.sessionId}/`) === true,
          `the session runs at ${JSON.stringify(childAt)}, not in the entry's Rex session ${entry.sessionId}`,
        )
        const view = await rex.view(entry.sessionId)
        expect(
          windowOf(view, blockOf(childAt.id)) !== undefined &&
            windowOf(view, blockOf(childAt.id)) !== windowOf(view, blockOf(entry.terminal)),
          `the session is not in a window of its own: ${JSON.stringify(view)}`,
        )
        await until("the first execution completed", () => completed(w, first.id) === 1, 60_000)

        await w.ok(["send", first.id, "--", "rex-again"], { env: rex.env })
        await until("the sent message's execution completed", () => completed(w, first.id) === 2, 90_000)

        const shared = JSON.parse(
          await w.okViaEntry(
            ["run", "pi", "--share", first.id, "--title", "Verify in split block", "--", "rex-share"],
            { cwd: repo, asIs: true, timeoutMs: 90_000 },
          ),
        ) as { id: string }

        await until("the shared session's execution completed", () => completed(w, shared.id) === 1, 90_000)
        const sharedAt = runtimeOf(w, shared.id)
        const after = await rex.view(entry.sessionId)
        expect(
          sharedAt.kind === "rex" &&
            sharedAt.id?.startsWith(`${entry.sessionId}/`) === true &&
            windowOf(after, blockOf(sharedAt.id)) === windowOf(after, blockOf(childAt.id)),
          `the --share session at ${JSON.stringify(sharedAt)} is not beside ${childAt.id}: ${JSON.stringify(after)}`,
        )

        const peeked = await w.ok(["peek", first.id], { env: rex.env })
        expect(peeked.includes("rex-again"), `peek did not read the session's block: ${peeked.slice(-800)}`)

        const doctor = await w.vibest(["doctor"], { env: rex.env })
        expect(
          doctor.stdout.includes(`✓ a Rex server answers at ${rex.socket}`) &&
            /Runtime: rex [^\n]*\n\s+✓ a Rex server answers at [^\n]*\n\s+✓ it speaks API revision \d+/.test(
              doctor.stdout,
            ),
          `vibest doctor does not report the Rex server: ${doctor.stdout}${doctor.stderr}`,
        )

        for (const id of [shared.id, first.id]) await w.ok(["archive", id], { env: rex.env })
        await until(
          "archive closed both blocks",
          async () => (await rex.blockGone(childAt.id!)) && (await rex.blockGone(sharedAt.id!)),
          30_000,
        )
        expect(childrenOf(w, entry.id).length === 2, `the entry session's children: ${childrenOf(w, entry.id)}`)
      } finally {
        model.stop()
        await w.stopDaemon()
        await rex.stop()
      }
    },
  },
  {
    id: "RX2",
    title:
      "Rex: vibest --runtime rex outside Rex starts the entry session in the project's Rex session; a session it runs answers, vibest stop closes its block, the next send resumes the same conversation in a new block, and after vibest daemon restart a send is still answered in that block; archive closes it",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      const model = codewordModel()
      const dir = await piDir(w, "pi-rx2", model.url)
      const rex = await rexServer(w, { PI_CODING_AGENT_DIR: dir })

      try {
        await lifecycle(w, rex, { entry: [], worker: [], timeoutMs: 90_000 })
      } finally {
        model.stop()
        await w.stopDaemon()
        await rex.stop()
      }
    },
  },
  {
    id: "RX4",
    tier: "agent",
    title:
      "Rex with a real model (the user's default Pi provider and model): a session started with --runtime rex keeps a codeword over vibest stop and resume, and answers after vibest daemon restart",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      const entry = recordingModel(() => reply("ok"))
      const real = await realPi(w, entry.url)
      const rex = await rexServer(w, { PI_CODING_AGENT_DIR: real.dir })

      try {
        await lifecycle(w, rex, {
          entry: ["--provider", "fake", "--model", "m"],
          worker: real.flags,
          timeoutMs: 300_000,
        })
      } finally {
        entry.stop()
        await w.stopDaemon()
        await rex.stop()
      }
    },
  },
  {
    id: "RX3",
    tier: "agent",
    title:
      "Rex with a real model (the user's default Pi provider and model): the entry session started in a Rex block runs a session with vibest run and a second with --share; the first commits in its worktree and its multiline vibest send wakes the entry session, which summarises it; a send to it is answered; peek, doctor and archive work on its block",
    run: async (w, evidence) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      const real = await realPi(w)
      const rex = await rexServer(w, { PI_CODING_AGENT_DIR: real.dir })

      try {
        await w.daemon({ env: rex.env })
        const repo = await project(w, "rexglm")
        const entry = await entryInRex(w, rex, repo, real.flags)
        const entryAt = runtimeOf(w, entry.id)
        expect(
          entryAt.kind === "rex" && entryAt.id === entry.terminal,
          `the entry session runs at ${JSON.stringify(entryAt)}, not in the Rex block ${entry.terminal}`,
        )
        await until(
          "the entry session's harness",
          () => row<{ pid: number | null }>(w, `SELECT pid FROM ${SESSIONS} s WHERE id = ?`, entry.id)?.pid != null,
          120_000,
        )

        const flags = real.flags.join(" ")

        const worker =
          "In your working directory create the file REX-NOTE.md holding the line rex ok, then git add it and git commit -m 'Add REX-NOTE'. " +
          "Then send your creator one report with vibest send: at least five lines, REPORT-1 to REPORT-5, each on its own line and saying one thing you did or saw, such as the commit hash. Keep the line breaks in the message."

        const task = [
          "This checks agents running in Rex. Do exactly these steps in your shell, and do not do the workers' work yourself:",
          `1. Run: vibest run pi ${flags} --title 'Inspect repo in Rex' -- "${worker}"`,
          "   It prints the new session's id as JSON.",
          `2. Run: vibest run pi ${flags} --share <the id from step 1> --title 'Verify in split block' -- "Run git log --oneline -3 and reply with its output. Change no file."`,
          "3. End your turn. When the report of the first session arrives as a <vibest-agent-message>, reply with a short summary of it whose first word is SUMMARY-REX. Archive nothing.",
        ].join("\n")

        await w.ok(["send", entry.id, "--", task], { cwd: repo, env: rex.env })

        const firstChild = () => childrenOf(w, entry.id)[0]

        const reports = () =>
          rows<{ content: string; execution: number | null }>(
            w,
            "SELECT content, recipient_execution_id AS execution FROM inbox WHERE recipient_session_id = ? AND sender_session_id = ? ORDER BY id",
            entry.id,
            firstChild() ?? "",
          ).filter((r) => r.content.split("\n").filter((l) => /REPORT-\d/.test(l)).length >= 5)

        const summarised = () => {
          const delivered = reports().find((r) => r.execution !== null)

          return delivered === undefined
            ? undefined
            : row<{ reply: string | null; outcome: string | null }>(
                w,
                "SELECT reply, outcome FROM execution WHERE session_id = ? AND id >= ? AND outcome = 'completed' AND reply LIKE '%SUMMARY-REX%' ORDER BY id LIMIT 1",
                entry.id,
                delivered.execution!,
              )
        }

        const shown = async (e: Error) => {
          await w.writeEvidence(path.join(evidence, "RX3-rex-screens.txt"), await rex.screens())
          throw new Error(`${e.message}; Rex shows:\n${(await rex.screens()).slice(-6000)}`)
        }

        await until("two sessions run by the entry session", () => childrenOf(w, entry.id).length >= 2, 600_000).catch(
          shown,
        )
        await until("the multiline report of the first session", () => reports().length > 0, 600_000).catch(shown)
        await until("the entry session's summary of the report", () => summarised() !== undefined, 600_000).catch(shown)

        const report = reports()[0]!.content
        const piSessions = path.join(real.dir, "sessions")

        const received = (await fsPromises.readdir(piSessions, { recursive: true }))
          .filter((f) => f.endsWith(".jsonl"))
          .some((f) => fs.readFileSync(path.join(piSessions, f), "utf8").includes(JSON.stringify(report).slice(1, -1)))

        expect(received, `the entry session's Pi did not receive the report whole: ${JSON.stringify(report)}`)

        const [first, second] = childrenOf(w, entry.id) as [string, string]

        const directoryOf = (id: string) =>
          row<{ directory: string }>(w, "SELECT directory FROM session WHERE id = ?", id)!.directory

        const firstAt = runtimeOf(w, first)
        const secondAt = runtimeOf(w, second)
        const view = await rex.view(entry.sessionId)
        expect(
          [firstAt, secondAt].every((at) => at.kind === "rex" && at.id?.startsWith(`${entry.sessionId}/`) === true) &&
            directoryOf(second) === directoryOf(first) &&
            windowOf(view, blockOf(secondAt.id)) === windowOf(view, blockOf(firstAt.id)),
          `the --share session ${JSON.stringify(secondAt)} is not a split beside ${JSON.stringify(firstAt)}: ${JSON.stringify(view)}`,
        )
        const committed = await w.run(directoryOf(first), ["git", "log", "--format=%s", "-1", "--", "REX-NOTE.md"])
        expect(
          committed.stdout.trim() !== "",
          `the first session committed no REX-NOTE.md: ${committed.stdout}${committed.stderr}`,
        )

        const before = completed(w, first)
        await w.ok(["send", first, "--", "Run no command and use no tool. Reply with exactly: REX-FOLLOWUP-OK"], {
          cwd: repo,
          env: rex.env,
        })
        await until("the follow-up execution completed", () => completed(w, first) > before, 300_000).catch(shown)
        expect(replyOf(w, first).includes("REX-FOLLOWUP-OK"), `the follow-up reply: ${replyOf(w, first)}`)

        const peeked = await w.ok(["peek", first], { cwd: repo, env: rex.env })
        expect(peeked.includes("REX-FOLLOWUP-OK"), `peek did not read the session's block: ${peeked.slice(-800)}`)

        const doctor = await w.vibest(["doctor"], { env: rex.env })
        expect(
          /Runtime: rex [^\n]*\n\s+✓ a Rex server answers at [^\n]*\n\s+✓ it speaks API revision \d+/.test(
            doctor.stdout,
          ),
          `vibest doctor does not report the Rex server: ${doctor.stdout}${doctor.stderr}`,
        )

        await w.writeEvidence(
          path.join(evidence, "RX3-transcript.txt"),
          `report:\n${report}\n\nsummary:\n${summarised()?.reply}\n\nRex:\n${await rex.screens()}`,
        )

        for (const id of [second, first]) await w.ok(["archive", id], { cwd: repo, env: rex.env })
        await until(
          "archive closed both blocks",
          async () => (await rex.blockGone(firstAt.id!)) && (await rex.blockGone(secondAt.id!)),
          30_000,
        )
      } finally {
        await w.stopDaemon()
        await rex.stop()
      }
    },
  },
]

export default checks
