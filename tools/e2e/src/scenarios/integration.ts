import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import {
  claudeConfigOf,
  claudeEnv,
  fakeAnthropic,
  fakeOpenAI,
  lastUser,
  piDir,
  resultText,
  type Step,
  subagentFolder,
  text,
} from "../fake-model.ts"
import {
  agentName,
  compiled,
  expect,
  harnesses,
  herdr,
  row,
  SESSIONS,
  Skip,
  until,
  type World,
  writeEvidence,
} from "../world.ts"
import { dropHerdrSession, project as newRepository } from "./inbox.ts"

const HERDR_TASK = "Run this shell command exactly as written: herdr pane list > herdr-ran.txt. Then reply with: pong"

const listed = async (w: World, id: string, cwd = w.repository) =>
  (await w.json<Array<{ id: string; status: string; turnState: string; worktree: string }>>(["ls"], { cwd })).find(
    (e) => e.id === id,
  )
const turnState = async (w: World, id: string, cwd = w.repository) => (await listed(w, id, cwd))?.turnState

const latest = async (w: World, id: string, cwd = w.repository) =>
  (await w.json<{ result?: { id: number; message: string } | null }>(["result", id], { cwd })).result ?? undefined

const ends = async (w: World, id: string) =>
  (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).split("\n").flatMap((l) => {
    const found = new RegExp(`turn end ${id} \\((\\w+)(, interrupted)?\\)`).exec(l)
    return found ? [{ harness: found[1]!, interrupted: found[2] !== undefined }] : []
  })

const withSession = async (
  w: World,
  harness: string,
  flags: ReadonlyArray<string>,
  task: string,
  body: (s: { id: string; socket: string }) => Promise<void>,
  options: { cwd?: string } = {},
) => {
  const session = `${w.herdrSession}-${harness}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  await w.stopDaemon()
  await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined } })
  let id = ""
  try {
    const run = await w.ok(["run", harness, ...flags, "--session", session, "--", task], {
      timeoutMs: 120_000,
      ...options,
    })
    id = (JSON.parse(run) as { id: string }).id
    await body({ id, socket })
  } finally {
    if (id) await w.vibest(["archive", id], { timeoutMs: 60_000, ...options })
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

const installBesidePlugin = async (w: World, config: string) => {
  const market = path.join(w.root, "claude-market")
  const beside = path.join(market, "plugins", "beside")
  const besideRan = path.join(w.root, "beside-ran")
  await fs.mkdir(path.join(market, ".claude-plugin"), { recursive: true })
  await fs.mkdir(path.join(beside, ".claude-plugin"), { recursive: true })
  await fs.mkdir(path.join(beside, "hooks"), { recursive: true })
  await fs.writeFile(
    path.join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "e2e-local",
      owner: { name: "e2e" },
      plugins: [{ name: "e2e-beside", source: "./plugins/beside", description: "e2e" }],
    }),
  )
  await fs.writeFile(
    path.join(beside, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "e2e-beside", version: "1.0.0", description: "e2e" }),
  )
  await fs.writeFile(
    path.join(beside, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch '${besideRan}'` }] }] },
    }),
  )
  for (const argv of [
    ["claude", "plugin", "marketplace", "add", market],
    ["claude", "plugin", "install", "e2e-beside@e2e-local"],
  ]) {
    const r = await w.run(w.root, argv, { env: { CLAUDE_CONFIG_DIR: config } })
    expect(r.code === 0, `${argv.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`)
  }
  return besideRan
}

const checks: ReadonlyArray<Check> = [
  {
    id: "I11",
    title:
      "another vibest first on PATH (an older install): a Pi main agent, a Pi subagent and a Claude subagent still reach this build's vibestd through their integrations, and the other vibest never runs",
    run: async (w) => {
      for (const bin of ["pi", "claude", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const other = path.join(w.root, "other-vibest")
      const ran = path.join(w.root, "other-vibest-ran")
      await fs.mkdir(other, { recursive: true })
      await fs.writeFile(
        path.join(other, "vibest"),
        `#!/bin/sh\necho "$@" >> '${ran}'\necho "not the vibest under test" >&2\nexit 1\n`,
        { mode: 0o755 },
      )
      const zdot = path.join(w.root, "zdotdir-other")
      await fs.mkdir(zdot, { recursive: true })
      const env = { PATH: `${other}:${w.env().PATH}`, ZDOTDIR: zdot }
      const pi = fakeOpenAI(
        (who, _dir, _done, last) => (who === "pi" && last === undefined ? "pong\nstatus: completed" : "ok"),
        {},
      )
      const claude = fakeAnthropic((r) =>
        r.tools.length > 0 && subagentFolder(r.system) !== undefined ? "pong\nstatus: completed" : "ok",
      )
      const session = `${w.herdrSession}-other`
      try {
        const piEnv = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-other", pi.url)}`
        await w.daemon({ env })
        await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", piEnv], { env, timeoutMs: 90_000 })
        const run = async (flags: ReadonlyArray<string>) =>
          (
            JSON.parse(
              await w.ok(["run", ...flags, "--session", session, "--", "Answer once."], { env, timeoutMs: 120_000 }),
            ) as { id: string }
          ).id
        const subs = [
          await run(["pi", "--env", piEnv]),
          await run(["claude", ...(await claudeEnv(w, "other", claude.url))]),
        ]
        for (const id of subs) {
          await until(`${id}'s result`, async () => (await turnState(w, id)) === "completed", 120_000)
          expect(/pong/.test((await latest(w, id))?.message ?? ""), `${id}: ${(await latest(w, id))?.message}`)
        }
        const main = (await w.json<Array<{ id: string; agent: string }>>(["ls"])).find((e) => e.agent === "main")
        expect(main !== undefined, "no main agent")
        await until(
          "the Pi main agent's ready report",
          () =>
            row<{ c: string | null }>(w, `SELECT harness_session_id AS c FROM ${SESSIONS} s WHERE id = ?`, main!.id)
              ?.c != null,
          60_000,
        )
        expect(
          !(await Bun.file(ran).exists()),
          `the other vibest ran: ${await Bun.file(ran)
            .text()
            .catch(() => "")}`,
        )
      } finally {
        pi.stop()
        claude.stop()
        await w.stopDaemon()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "I1",
    title:
      "the plugins ship with vibest: one directory per harness; `integration` has only the hooks' guard, prompt, stop and ready and a main agent's restart start, nothing to install",
    run: async (w) => {
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
        JSON.stringify(subcommands) === JSON.stringify(["guard", "prompt", "stop", "ready", "start"]),
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
      "Pi: vibest run pi (fake model) loads the built extension, which refuses the session's herdr call in process, and the reply lands as the session result",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const ran = path.join(w.root, "pi-herdr-ran.txt")
      const results: Array<string> = []
      const model = fakeOpenAI((who, _dir, done, last) => {
        if (last !== undefined) results.push(last)
        if (who !== "pi") return "ok"
        return done === 0 ? { tool: "bash", input: { command: `herdr pane list > ${ran}` } } : "pong\nstatus: completed"
      }, {})
      try {
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-i3", model.url)}`
        await withSession(w, "pi", ["--env", env], "guard and result", async ({ id }) => {
          await until("the session's result", async () => (await turnState(w, id)) === "completed", 120_000)
          expect(
            results.some((r) => r.includes("Agents must not control herdr")),
            `the herdr call was not refused: ${JSON.stringify(results)}`,
          )
          expect(!(await Bun.file(ran).exists()), "herdr ran: pi-herdr-ran.txt exists")
          const message = (await latest(w, id))?.message ?? ""
          expect(/<harness>pi<\/harness>/.test(message) && /pong/.test(message), message)
        })
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "I5",
    tier: "agent",
    title:
      "Cursor (real model): vibest run cursor loads the built plugin beside the project's own hooks; asked to run herdr, herdr does not run (whether the model tries or keeps to its rules is recorded), and the reply lands as the session result",
    run: async (w, evidence) => {
      for (const bin of ["cursor-agent", "herdr"])
        if (!Bun.which(bin, { PATH: w.env().PATH! })) throw new Skip(`${bin} not on PATH`)
      const login = await w.run(w.repository, ["cursor-agent", "status"])
      if (!/Logged in/.test(login.stdout + login.stderr))
        throw new Skip(`cursor-agent is not logged in: ${(login.stdout + login.stderr).trim()}`)
      const repo = await newRepository(w, "cursor-turn")
      const projectHookLog = path.join(w.root, "project-hook.log")
      await fs.mkdir(path.join(repo, ".cursor"), { recursive: true })
      await fs.writeFile(
        path.join(repo, ".cursor/hooks.json"),
        JSON.stringify({
          version: 1,
          hooks: { sessionStart: [{ command: `echo ran >> '${projectHookLog}'; echo {}` }] },
        }),
      )
      for (const argv of [
        ["git", "add", "."],
        ["git", "commit", "-q", "-m", "project hooks"],
      ]) {
        const r = await w.run(repo, argv)
        expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
      }
      const daemonLog = path.join(w.vibestHome, "vibestd.log")
      const logFrom = (await fs.readFile(daemonLog, "utf8").catch(() => "")).length
      await withSession(
        w,
        "cursor",
        [],
        HERDR_TASK,
        async ({ id }) => {
          const rerouted = /harness "cursor" → "(\w+)"/.exec(
            (await fs.readFile(daemonLog, "utf8").catch(() => "")).slice(logFrom),
          )
          expect(rerouted === null, `harness-choice routed cursor to ${rerouted?.[1] ?? "another harness"}`)
          await until(
            "the session's result",
            async () => ["completed", "failed"].includes((await turnState(w, id, repo)) ?? ""),
            240_000,
          )
          const message = (await latest(w, id, repo))?.message ?? ""
          expect((await turnState(w, id, repo)) === "completed", `the turn did not complete: ${message}`)
          const worktree = await fs.realpath((await listed(w, id, repo))!.worktree)
          expect(!(await Bun.file(path.join(worktree, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
          const transcripts = path.join(w.home, ".cursor", "projects", worktree.slice(1).replace(/[^a-zA-Z0-9]/g, "-"))
          const files = (await fs.readdir(transcripts, { recursive: true }).catch(() => [] as Array<string>)).filter(
            (f) => f.endsWith(".jsonl"),
          )
          expect(files.length > 0, `no Cursor transcript in ${transcripts}`)
          const tried = (await Promise.all(files.map((f) => fs.readFile(path.join(transcripts, f), "utf8")))).some(
            (t) => /"tool_use".*herdr pane list/.test(t),
          )
          await writeEvidence(path.join(evidence, "I5-herdr-call.json"), `${JSON.stringify({ tried, transcripts })}\n`)
          expect(/<status>completed<\/status>/.test(message), message)
          expect(
            /<harness>cursor<\/harness>/.test(message) && /<result>[\s\S]*\bpong\b[\s\S]*<\/result>/.test(message),
            message,
          )
          expect(await Bun.file(projectHookLog).exists(), "the project's own sessionStart hook did not run")
        },
        { cwd: repo },
      )
    },
  },
  {
    id: "I7",
    covers: ["I4"],
    title:
      "Claude (fake model): every main-loop turn end is the plugin's turn.complete: an answer is the result, Esc in the pane is one interrupted result, `vibest interrupt` is none; I4: vibest's plugin loads beside a plugin the user installed",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const HOLD = "Keep working on this until you are stopped."
      let held = 0
      const model = fakeAnthropic((r) => {
        if (r.tools.length === 0 || subagentFolder(r.system) === undefined) return "ok"
        if (!text(lastUser(r)).includes(HOLD)) return "status: completed\nsummary: e2e answer"
        held++
        return new Promise<Step>(() => {})
      })
      try {
        const flags = await claudeEnv(w, "turns", model.url)
        const besideRan = await installBesidePlugin(w, claudeConfigOf(flags))
        await withSession(w, "claude", flags, "Answer once.", async ({ id, socket }) => {
          const settled = (want: string) => async () => (await turnState(w, id)) === want
          await until("the answer's result", settled("completed"), 120_000)
          const first = await latest(w, id)
          expect(
            /<status>completed<\/status>/.test(first?.message ?? "") &&
              /<harness>claude<\/harness>/.test(first?.message ?? "") &&
              /summary: e2e answer/.test(first?.message ?? ""),
            `answer result: ${first?.message.slice(0, 500)}`,
          )
          expect(await Bun.file(besideRan).exists(), "I4: the installed plugin's SessionStart hook did not run")
          const aborted = async () => (await ends(w, id)).filter((e) => e.interrupted).length

          await w.ok(["send", id, HOLD])
          await until("the held turn at the model", () => held === 1, 60_000)
          await until("the held turn open", settled("open"), 60_000)
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

          await w.ok(["send", id, HOLD])
          await until("the second held turn at the model", () => held === 2, 60_000)
          await until("the second held turn open", settled("open"), 60_000)
          await w.ok(["interrupt", id], { timeoutMs: 60_000 })
          await until("the interrupted turn's turn.complete", async () => (await aborted()) === 2, 30_000)
          await until("the turn interrupted", settled("interrupted"), 30_000)
          const third = await latest(w, id)
          expect(third?.id === second!.id, `a result after vibest interrupt: ${third?.message.slice(0, 500)}`)
        })
      } finally {
        model.stop()
      }
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
        await withSession(w, "claude", await claudeEnv(w, "guard", model.url), "guard test", async ({ id, socket }) => {
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
        })
      } finally {
        model.stop()
      }
    },
  },
]

export default checks
