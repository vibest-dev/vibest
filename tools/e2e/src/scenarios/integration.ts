import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Check } from "../check.ts"
import { claudeEnv, fakeAnthropic, resultText, type Step, subagentFolder } from "../fake-model.ts"
import {
  agentModel,
  agentName,
  binary,
  compiled,
  expect,
  harnesses,
  herdr,
  knownSessions,
  Skip,
  until,
  type World,
} from "../world.ts"
import { project as newRepository } from "./inbox.ts"

const userHarnessFiles = [".claude/settings.json", ".cursor/hooks.json", ".pi/agent/settings.json"].map((p) =>
  path.join(os.homedir(), p),
)
const stamp = () =>
  Promise.all(
    userHarnessFiles.map((p) =>
      fs.stat(p).then(
        (s) => `${p} ${s.mtimeMs}`,
        () => `${p} missing`,
      ),
    ),
  )
let realBefore: Promise<Array<string>> | undefined

const PROMPT =
  "Run this shell command exactly as written: herdr pane list > herdr-ran.txt. Whatever happens, then reply with exactly: pong"
const untilFile = path.join(import.meta.dirname, "../until-file.py")
// oxlint-disable-next-line no-control-regex -- the escape character is the ANSI CSI lead; stripping harness output needs it
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")

const workdir = async (w: World, name: string) => {
  const dir = path.join(w.root, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const resultMessage = async (w: World, id: string) => {
  let message = ""
  await until(`${id}'s result`, async () => (message = (await latest(w, id))?.message ?? "") !== "", 30_000)
  return message
}

const untilResult = async <A>(w: World, id: string, run: (marker: string) => Promise<A>) => {
  const marker = path.join(w.root, `${id}.result`)
  let done = false
  const poll = (async () => {
    while (!done) {
      if (await latest(w, id).catch(() => undefined)) return fs.writeFile(marker, "")
      await Bun.sleep(1000)
    }
  })()
  try {
    return await run(marker)
  } finally {
    done = true
    await poll
  }
}

const listed = async (w: World, id: string) =>
  (await w.json<Array<{ id: string; status: string; turnState: string; worktree: string }>>(["ls"])).find(
    (e) => e.id === id,
  )
const status = async (w: World, id: string) => (await listed(w, id))?.status
const turnState = async (w: World, id: string) => (await listed(w, id))?.turnState

const latest = async (w: World, id: string) =>
  (await w.json<{ result?: { id: number; message: string } | null }>(["result", id])).result ?? undefined

const ends = async (w: World, id: string) =>
  (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).split("\n").flatMap((l) => {
    const found = new RegExp(`turn end ${id} \\((\\w+)(, interrupted)?\\)`).exec(l)
    return found ? [{ harness: found[1]!, interrupted: found[2] !== undefined }] : []
  })

const STORY = "Do not use any tools. Write a very long story, at least 4000 words, about a lighthouse keeper."

const withClaudeSession = async (
  w: World,
  body: (s: { id: string; socket: string }) => Promise<void>,
  task = STORY,
  flags: ReadonlyArray<string> = agentModel(),
) => {
  const session = `${w.herdrSession}-claude`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const zdot = path.join(w.root, "zdotdir")
  await fs.mkdir(zdot, { recursive: true })
  await w.stopDaemon()
  await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined, ZDOTDIR: zdot } })
  let id = ""
  try {
    const run = await w.ok(["run", "claude", ...flags, "--session", session, "--", task], {
      timeoutMs: 120_000,
    })
    id = (JSON.parse(run) as { id: string }).id
    await body({ id, socket })
  } finally {
    if (id) await w.vibest(["archive", id], { timeoutMs: 60_000 })
    await w.stopDaemon()
    if (
      await fs.stat(path.dirname(socket)).then(
        () => true,
        () => false,
      )
    ) {
      await w.run(w.root, ["herdr", "session", "stop", session])
      await w.run(w.root, ["herdr", "session", "delete", session])
    }
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "I1",
    title:
      "the plugins ship with vibest: one directory per harness; `integration` has only the hooks' guard, prompt and stop and a main agent's restart start, nothing to install",
    run: async (w) => {
      realBefore ??= stamp()
      await realBefore
      for (const file of [
        "pi/extension.mjs",
        "claude/.claude-plugin/plugin.json",
        "claude/hooks/register.mjs",
        "cursor/.cursor-plugin/plugin.json",
        "cursor/hooks/hooks.json",
        ...["pi", "claude", "cursor"].flatMap((h) => [
          `${h}/skills/delegate/SKILL.md`,
          `${h}/skills/pipeline/SKILL.md`,
        ]),
      ])
        expect(await Bun.file(path.join(harnesses, file)).exists(), `missing ${file} in ${harnesses}`)
      const install = await w.vibest(["integration", "install", "pi"])
      expect(install.code !== 0, `integration install still exists: ${install.stdout}`)
      const help = await w.ok(["integration", "--help"])
      const subcommands = [...help.matchAll(/^ {2}(\w+) {2,}/gm)].map((m) => m[1])
      expect(
        JSON.stringify(subcommands) === JSON.stringify(["guard", "prompt", "stop", "start"]),
        `subcommands: ${subcommands.join(", ")}`,
      )
    },
  },
  {
    id: "I2",
    title:
      "vibest finds its plugins: npm's launcher passes them, the bare binary looks beside its bin/; with none it refuses each harness, and says why",
    run: async (w) => {
      const beside = await w.vibest(["doctor"], { env: { VIBEST_HARNESSES: undefined }, timeoutMs: 120_000 })
      for (const h of ["pi", "claude", "cursor"])
        expect(!new RegExp(`^  . ${h} .*plugin`, "m").test(beside.stdout), `${h}:\n${beside.stdout}`)
      const solo = path.join(w.root, "solo", "bin")
      await fs.mkdir(solo, { recursive: true })
      await fs.copyFile(compiled, path.join(solo, "vibest"))
      await fs.chmod(path.join(solo, "vibest"), 0o755)
      const r = await w.run(w.repository, [path.join(solo, "vibest"), "doctor"], {
        env: { VIBEST_HARNESSES: undefined },
        timeoutMs: 120_000,
      })
      const resolvedSolo = await fs.realpath(path.join(w.root, "solo"))
      for (const h of ["pi", "claude", "cursor"])
        expect(
          new RegExp(
            `^  ✗ ${h} +vibest's ${h} plugin is missing: ${path.join(resolvedSolo, "harnesses", h)}$`,
            "m",
          ).test(r.stdout),
          `${h}:\n${r.stdout}`,
        )
    },
  },
  {
    id: "I3",
    title:
      "Pi: a real Pi with the built extension (pi -e) refuses an agent's herdr call in process, and its reply lands as the session result",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      const cwd = await workdir(w, "pi-turn")
      const id = "e2e00003-e2e0-4e2e-8e2e-e2e00003e2e0"
      const project = await knownSessions(w, { [id]: "general" }, cwd, "pi")
      const r = await untilResult(w, id, (marker) =>
        w.run(
          cwd,
          [
            "python3",
            "-I",
            untilFile,
            marker,
            "180",
            "pi",
            "--no-session",
            "-e",
            path.join(harnesses, "pi", "extension.mjs"),
            PROMPT,
          ],
          {
            env: {
              PI_CODING_AGENT_DIR: undefined,
              VIBEST_AGENT: "general",
              VIBEST_SESSION_ID: id,
              VIBEST_PROJECT_ID: String(project),
              VIBEST_HARNESS: "pi",
              VIBEST_COMMAND: JSON.stringify([binary]),
            },
            timeoutMs: 240_000,
          },
        ),
      )
      expect(r.code === 0, `no result within 180s; screen:\n${plain(r.stderr)}`)
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      const message = await resultMessage(w, id)
      expect(/<harness>pi<\/harness>/.test(message) && /pong/.test(message), message)
    },
  },
  {
    id: "I4",
    title:
      "Claude: a real Claude with the built plugin (--plugin-dir) refuses an agent's herdr call, reports its turn end, and the user's installed plugins still load",
    run: async (w) => {
      if (!Bun.which("claude")) throw new Skip("claude not on PATH")
      const cwd = await workdir(w, "claude-turn")
      const id = "e2e00004-e2e0-4e2e-8e2e-e2e00004e2e0"
      const project = await knownSessions(w, { [id]: "general" }, cwd)
      const r = await w.run(
        cwd,
        [
          "claude",
          "-p",
          "--model",
          "haiku",
          "--no-session-persistence",
          "--plugin-dir",
          path.join(harnesses, "claude"),
          "--allowedTools",
          "Bash",
          "--output-format",
          "stream-json",
          "--verbose",
          PROMPT,
        ],
        {
          env: {
            CLAUDE_CONFIG_DIR: undefined,
            CLAUDECODE: undefined,
            CLAUDE_CODE_ENTRYPOINT: undefined,
            VIBEST_AGENT: "general",
            VIBEST_SESSION_ID: id,
            VIBEST_PROJECT_ID: String(project),
            VIBEST_HARNESS: "claude",
          },
          timeoutMs: 240_000,
        },
      )
      expect(r.code === 0, `claude exited ${r.code}: ${r.stderr}`)
      const lines = r.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      const init = lines.find((l) => l.type === "system" && l.subtype === "init") as
        | { plugins?: Array<{ name: string }> }
        | undefined
      const loaded = (init?.plugins ?? []).map((p) => p.name)
      const installed = Object.keys(
        (
          JSON.parse(
            await fs.readFile(path.join(w.home, ".claude/plugins/installed_plugins.json"), "utf8").catch(() => "{}"),
          ) as { plugins?: object }
        ).plugins ?? {},
      )
      expect(loaded.includes("vibest"), `vibest's plugin did not load: ${loaded.join(", ")}`)
      expect(
        installed.length === 0 || loaded.length > 1,
        `only vibest's plugin loaded; installed: ${installed.join(", ")}`,
      )
      expect(/Agents must not control herdr/.test(r.stdout), "no guard refusal in the transcript")
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      const message = await resultMessage(w, id)
      expect(/<harness>claude<\/harness>/.test(message) && /pong/.test(message), message)
    },
  },
  {
    id: "I5",
    title:
      "Cursor: a real cursor-agent with the built plugin (--plugin-dir) refuses an agent's herdr call, its reply lands as the session result, and the project's own hooks still run",
    run: async (w) => {
      if (!Bun.which("cursor-agent", { PATH: w.env().PATH })) throw new Skip("cursor-agent not on PATH")
      const login = await w.run(w.repository, ["cursor-agent", "status"])
      if (!/Logged in/.test(login.stdout + login.stderr))
        throw new Skip(`cursor-agent is not logged in: ${(login.stdout + login.stderr).trim()}`)
      const cwd = await workdir(w, "cursor-turn")
      const projectHookLog = path.join(w.root, "project-hook.log")
      await fs.mkdir(path.join(cwd, ".cursor"), { recursive: true })
      await fs.writeFile(
        path.join(cwd, ".cursor/hooks.json"),
        JSON.stringify({
          version: 1,
          hooks: { sessionStart: [{ command: `echo ran >> '${projectHookLog}'; echo {}` }] },
        }),
      )
      const bin = path.join(w.root, "bin")
      const calls = path.join(w.root, "vibest-calls.log")
      await fs.mkdir(bin, { recursive: true })
      await fs.writeFile(
        path.join(bin, "vibest"),
        `#!/bin/sh\nin=$(cat)\nout=$(printf '%s' "$in" | "${binary}" "$@" 2>>"${calls}"); code=$?\nprintf '%s => %s (exit %s) <= %s\\n' "$*" "$out" "$code" "$in" >> "${calls}"\nprintf '%s\\n' "$out"\nexit $code\n`,
        { mode: 0o755 },
      )
      const id = "e2e00005-e2e0-4e2e-8e2e-e2e00005e2e0"
      const project = await knownSessions(w, { [id]: "general" }, cwd, "cursor")
      const r = await untilResult(w, id, (marker) =>
        w.run(
          cwd,
          [
            "python3",
            "-I",
            untilFile,
            marker,
            "240",
            "cursor-agent",
            "--trust",
            "--force",
            "--plugin-dir",
            path.join(harnesses, "cursor"),
            PROMPT,
          ],
          {
            env: {
              VIBEST_AGENT: "general",
              VIBEST_SESSION_ID: id,
              VIBEST_PROJECT_ID: String(project),
              VIBEST_HARNESS: "cursor",
              VIBEST_COMMAND: JSON.stringify([path.join(bin, "vibest")]),
              PATH: `${bin}:${w.env().PATH}`,
            },
            timeoutMs: 300_000,
          },
        ),
      )
      const log = await fs.readFile(calls, "utf8").catch(() => "")
      expect(
        /^integration guard --harness cursor => .*"permission":"deny".*herdr/m.test(log),
        `no guard refusal recorded:\n${log}\nscreen:\n${plain(r.stderr)}`,
      )
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      expect(r.code === 0, `no result within 240s; vibest calls:\n${log}\nscreen:\n${plain(r.stderr)}`)
      const message = await resultMessage(w, id)
      expect(/<harness>cursor<\/harness>/.test(message) && /pong/.test(message), message)
      expect(await Bun.file(projectHookLog).exists(), "the project's own sessionStart hook did not run")
    },
  },
  {
    id: "I7",
    title:
      "Claude: every main-loop turn end is the plugin's turn.complete: an answer is the result, Esc in the pane is one interrupted result, `vibest interrupt` is none",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const answer = "Do not use tools. Reply with exactly two lines: `status: completed` and `summary: e2e answer`."
      await withClaudeSession(
        w,
        async ({ id, socket }) => {
          const settled = (want: string) => async () => (await turnState(w, id)) === want
          await until("the answer's result", settled("completed"), 120_000)
          const first = await latest(w, id)
          expect(
            /<status>completed<\/status>/.test(first?.message ?? "") &&
              /summary: e2e answer/.test(first?.message ?? ""),
            `answer result: ${first?.message.slice(0, 500)}`,
          )
          const aborted = async () => (await ends(w, id)).filter((e) => e.interrupted).length

          await w.ok(["send", id, STORY])
          await until("the story turn", settled("open"), 60_000)
          await Bun.sleep(10_000)
          const esc = await w.run(w.root, ["herdr", "agent", "send-keys", agentName(id), "esc"], {
            env: { HERDR_SOCKET_PATH: socket },
          })
          expect(esc.code === 0, `herdr send-keys esc: ${esc.stderr}`)
          await until("the interrupted result", settled("failed"), 60_000)
          const second = await latest(w, id)
          expect(
            second !== undefined &&
              second.id !== first!.id &&
              second.message.includes("interrupted: the turn was stopped in its terminal (Esc) before it ended"),
            `Esc result: ${second?.message.slice(0, 500)}`,
          )
          expect((await aborted()) === 1, `turn ends: ${JSON.stringify(await ends(w, id)).slice(0, 1000)}`)

          await w.ok(["send", id, STORY])
          await until("the second story turn", settled("open"), 60_000)
          await Bun.sleep(10_000)
          await w.ok(["interrupt", id], { timeoutMs: 60_000 })
          await until("the interrupted turn's turn.complete", async () => (await aborted()) === 2, 30_000)
          await Bun.sleep(5_000)
          expect((await turnState(w, id)) === "interrupted", `turn state: ${await turnState(w, id)}`)
          const third = await latest(w, id)
          expect(third?.id === second!.id, `a result after vibest interrupt: ${third?.message.slice(0, 500)}`)
        },
        answer,
      )
    },
  },
  {
    id: "I8",
    title: "`vibest peek <id> [--lines N]` prints the session's terminal on demand; an unknown id is refused",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      await withClaudeSession(w, async ({ id }) => {
        await until("the session working", async () => (await status(w, id)) === "working", 120_000)
        let screen = ""
        await until(
          "Claude's input box on the session's screen",
          async () => /❯/.test((screen = await w.ok(["peek", id]))),
          60_000,
        ).catch((e: Error) => {
          throw new Error(`${e.message}; vibest peek printed:\n${screen}`)
        })
        const few = await w.ok(["peek", id, "--lines", "3"])
        expect(few.trimEnd().split("\n").length <= 3, `--lines 3 printed:\n${few}`)
        const unknown = await w.vibest(["peek", "nope0000"])
        expect(unknown.code !== 0 && /NoSuchSession/.test(unknown.stderr), `${unknown.code}: ${unknown.stderr}`)
      })
    },
  },
  {
    id: "I9",
    title:
      "Claude with no --settings (fake model): the plugin's tool.call guard refuses a session's herdr call and its Read, find, grep and Grep of another project, still lets it read its own project folder, and no refused file's text reaches the model",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      type Info = { directory: string; preferences: string; memories: string; artifacts: string }
      const other = await w.json<Info>(["project", "info"], { cwd: await newRepository(w, "secret") })
      await fs.mkdir(other.memories, { recursive: true })
      await fs.writeFile(other.preferences, "The secret word is lighthouse.\n")
      await fs.writeFile(path.join(other.memories, "notes.md"), "The secret word is lighthouse.\n")
      const own = await w.json<Info>(["project", "info"])
      await fs.mkdir(own.artifacts, { recursive: true })
      await fs.writeFile(path.join(own.artifacts, "guard-ok.md"), "ok-own\n")
      const ran = path.join(w.root, "herdr-ran.txt")
      const herdrReason = "Sessions do not run herdr; vibest manages it."
      const offLimits =
        "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."
      const calls = (tools: ReadonlyArray<string>): ReadonlyArray<{ step: Exclude<Step, string>; reason?: string }> => [
        { step: { tool: "Bash", input: { command: `herdr --help > ${ran}` } }, reason: herdrReason },
        { step: { tool: "Read", input: { file_path: other.preferences } }, reason: offLimits },
        { step: { tool: "Bash", input: { command: `find ${other.memories} -name '*.md'` } }, reason: offLimits },
        { step: { tool: "Bash", input: { command: `grep -r secret ${other.directory}` } }, reason: offLimits },
        ...(tools.includes("Grep")
          ? [{ step: { tool: "Grep", input: { pattern: "secret", path: other.directory } }, reason: offLimits }]
          : []),
        { step: { tool: "Read", input: { file_path: path.join(own.artifacts, "guard-ok.md") } } },
      ]
      const model = fakeAnthropic((r) => {
        if (r.tools.length === 0 || subagentFolder(r.system) === undefined) return "ok"
        return calls(r.tools)[r.results.length]?.step ?? "status: completed\nsummary: guard test"
      })
      try {
        await withClaudeSession(
          w,
          async ({ id, socket }) => {
            await until("the session's result", async () => (await turnState(w, id)) === "completed", 180_000).catch(
              (e: Error) => {
                throw new Error(`${e.message}; the model got ${model.requests.length} requests`)
              },
            )
            const last = model.requests.findLast((r) => subagentFolder(r.system) !== undefined)
            expect(last !== undefined, "the session never asked the model with its system prompt")
            const made = calls(last!.tools)
            const answers = new Map(last!.results.map((x) => [x.tool_use_id, x]))
            made.forEach((c, i) => {
              const answer = answers.get(`toolu_${i}`)
              expect(answer !== undefined, `no answer to ${c.step.tool} ${JSON.stringify(c.step.input)}`)
              if (c.reason === undefined)
                expect(
                  answer!.is_error !== true && resultText(answer!).includes("ok-own"),
                  `reading its own project folder: ${resultText(answer!)}`,
                )
              else
                expect(
                  answer!.is_error === true && resultText(answer!).includes(c.reason),
                  `${c.step.tool} ${JSON.stringify(c.step.input)} answered ${resultText(answer!)}`,
                )
            })
            const leaked = model.requests.flatMap((r) => r.results).filter((x) => resultText(x).includes("lighthouse"))
            expect(leaked.length === 0, `a refused file's text reached the model: ${JSON.stringify(leaked)}`)
            expect(!(await Bun.file(ran).exists()), "herdr ran: herdr-ran.txt exists")
            const message = (await latest(w, id))?.message ?? ""
            expect(/summary: guard test/.test(message), `the session's result: ${message}`)
            const pane = (await w.json<Array<{ id: string; address?: { id: string } }>>(["ls"]))
              .find((e) => e.id === id)
              ?.address?.id.split("/")[1]
            const info = (await herdr(socket, "pane.process_info", { pane_id: pane ?? "" })).process_info as {
              foreground_processes?: Array<{ name: string; argv?: Array<string> | null }>
            }
            const argv = (info.foreground_processes ?? []).find((p) =>
              /claude/.test(`${p.name} ${p.argv?.[0] ?? ""}`),
            )?.argv
            expect(argv !== undefined && argv !== null, `no claude in the session's pane: ${JSON.stringify(info)}`)
            expect(!argv!.includes("--settings"), `claude started with --settings: ${argv!.join(" ")}`)
            const pluginDir = argv![argv!.indexOf("--plugin-dir") + 1] ?? ""
            expect(
              argv!.includes("--plugin-dir") && path.basename(pluginDir) === "claude",
              `claude started without vibest's plugin: ${argv!.join(" ")}`,
            )
          },
          "guard test",
          await claudeEnv(w, "guard", model.url),
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "I6",
    title: "the user's own harness config files did not change",
    run: async () => {
      const before = await (realBefore ??= stamp())
      const after = await stamp()
      before.forEach((b, i) => expect(b === after[i], `changed: ${b} → ${after[i]}`))
    },
  },
]

export default checks
