// vibest's plugin for each harness ships with vibest (apps/vibest-herdr/harnesses, VIBEST_HARNESSES) and is loaded into each
// harness vibest starts, for that session only: Pi `-e`, Claude and Cursor `--plugin-dir`. Nothing is installed, and the
// user's own plugins and hooks keep loading beside it. Each check runs the real harness with the user's own login and
// config (read, not written) and a temp VIBEST_HOME: an agent's herdr call is refused, and its reply lands as the result.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Check } from "../check.ts"
import { agentModel, binary, compiled, expect, harnesses, knownSessions, Skip, until, type World } from "../world.ts"

/**
 * The user's real harness files vibest could write: none of them may change during a run. `~/.cursor/cli-config.json`
 * is out: vibest never touches it, and cursor-agent rewrites that one itself while it runs.
 */
const REAL = [".claude/settings.json", ".cursor/hooks.json", ".pi/agent/settings.json"].map((p) =>
  path.join(os.homedir(), p),
)
const stamp = () =>
  Promise.all(
    REAL.map((p) =>
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

/** A working directory of its own for one harness's turn. */
const workdir = async (w: World, name: string) => {
  const dir = path.join(w.root, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** The session's result envelope, once its plugin wrote it. */
const result = async (w: World, id: string) =>
  JSON.parse(await fs.readFile(path.join(w.vibestHome, "results", `${id}.json`), "utf8")) as {
    harness: string
    payload: Record<string, unknown>
  }

/** A session as `vibest ls` shows it. */
const listed = async (w: World, id: string) =>
  (await w.json<Array<{ id: string; status: string; turnState: string; worktree: string }>>(["ls"])).find(
    (e) => e.id === id,
  )
const status = async (w: World, id: string) => (await listed(w, id))?.status
const turnState = async (w: World, id: string) => (await listed(w, id))?.turnState

/** The latest result row `vibest result` shows for a session: its inbox id and message. */
const latest = async (w: World, id: string) =>
  (await w.json<{ result?: { id: number; message: string } | null }>(["result", id])).result ?? undefined

/** The turn-end payloads in a session's report lines, oldest first. */
const ends = async (w: World, id: string) =>
  (await fs.readFile(path.join(w.vibestHome, "reports", `${id}.jsonl`), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { turn: string; payload?: Record<string, unknown> })
    .flatMap((l) => (l.turn === "end" && l.payload ? [l.payload] : []))

const STORY = "Do not use any tools. Write a very long story, at least 4000 words, about a lighthouse keeper."

/**
 * One real Claude session (`vibest run claude`) on `task` (a long answer by default), in a herdr session of its own, with
 * the user's own Claude login: vibestd is started anew without CLAUDE_CONFIG_DIR, as S12 does, and the herdr session gets
 * its environment. An empty ZDOTDIR keeps a pane's zsh from reading the user's zshrc, which can put the user's own
 * installed `vibest` ahead of this build on PATH (the plugin's hooks run `vibest` from PATH). Archives the session and
 * stops that herdr session at the end.
 */
const withClaudeSession = async (
  w: World,
  body: (s: { id: string; socket: string }) => Promise<void>,
  task = STORY,
) => {
  const session = `${w.herdrSession}-claude`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const zdot = path.join(w.root, "zdotdir")
  await fs.mkdir(zdot, { recursive: true })
  await w.stopDaemon()
  await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined, ZDOTDIR: zdot } })
  let id = ""
  try {
    const run = await w.ok(["run", "claude", ...agentModel(), "--session", session, "--", task], {
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
      // Installed: npm's launcher. Built: dist/vibest beside apps/vibest-herdr/harnesses, as bin/vibest in a release archive.
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
      // The binary knows its own path resolved (/tmp is /private/tmp on macOS).
      const root = await fs.realpath(path.join(w.root, "solo"))
      for (const h of ["pi", "claude", "cursor"])
        expect(
          new RegExp(`^  ✗ ${h} +vibest's ${h} plugin is missing: ${path.join(root, "harnesses", h)}$`, "m").test(
            r.stdout,
          ),
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
      const id = "e2e00003"
      // The extension sends its turn end to vibestd, which writes the result file for a session it knows.
      const project = await knownSessions(w, "e2e/i3", { [id]: "general" }, cwd, "pi")
      // The user's own Pi config (its login and extensions); --no-session keeps the conversation out of it.
      const r = await w.run(
        cwd,
        [
          "python3",
          "-I",
          untilFile,
          path.join(w.vibestHome, "results", `${id}.json`),
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
      )
      expect(r.code === 0, `no result file within 180s; screen:\n${plain(r.stderr)}`)
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      const { harness, payload } = await result(w, id)
      expect(harness === "pi" && /pong/.test(String(payload.text)), JSON.stringify(payload))
    },
  },
  {
    id: "I4",
    title:
      "Claude: a real Claude with the built plugin (--plugin-dir) refuses an agent's herdr call, reports its turn end, and the user's installed plugins still load",
    run: async (w) => {
      if (!Bun.which("claude")) throw new Skip("claude not on PATH")
      const cwd = await workdir(w, "claude-turn")
      const id = "e2e00004"
      // The plugin talks to vibestd over HTTP, which answers only a session it knows.
      const project = await knownSessions(w, "e2e/i4", { [id]: "general" }, cwd)
      // The user's own Claude config (its login and plugins); --no-session-persistence keeps the conversation out of it.
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
      const { harness, payload } = await result(w, id)
      expect(harness === "claude" && /pong/.test(String(payload.text)), JSON.stringify(payload))
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
      // The user's own hooks, as a project keeps them: they run beside vibest's.
      const marker = path.join(w.root, "project-hook.log")
      await fs.mkdir(path.join(cwd, ".cursor"), { recursive: true })
      await fs.writeFile(
        path.join(cwd, ".cursor/hooks.json"),
        JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: `echo ran >> '${marker}'; echo {}` }] } }),
      )
      // The hooks' `vibest`, recorded: what it was asked and what it answered.
      const bin = path.join(w.root, "bin")
      const calls = path.join(w.root, "vibest-calls.log")
      await fs.mkdir(bin, { recursive: true })
      await fs.writeFile(
        path.join(bin, "vibest"),
        `#!/bin/sh\nin=$(cat)\nout=$(printf '%s' "$in" | "${binary}" "$@" 2>>"${calls}"); code=$?\nprintf '%s => %s (exit %s) <= %s\\n' "$*" "$out" "$code" "$in" >> "${calls}"\nprintf '%s\\n' "$out"\nexit $code\n`,
        { mode: 0o755 },
      )
      const id = "e2e00005"
      // `vibest integration event` sends each hook to vibestd, which writes the result file for a session it knows.
      const project = await knownSessions(w, "e2e/i5", { [id]: "general" }, cwd, "cursor")
      const r = await w.run(
        cwd,
        [
          "python3",
          "-I",
          untilFile,
          path.join(w.vibestHome, "results", `${id}.json`),
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
            PATH: `${bin}:${w.env().PATH}`,
          },
          timeoutMs: 300_000,
        },
      )
      const log = await fs.readFile(calls, "utf8").catch(() => "")
      expect(
        /^integration event --harness cursor preToolUse => .*"permission":"deny".*herdr/m.test(log),
        `no guard refusal recorded:\n${log}\nscreen:\n${plain(r.stderr)}`,
      )
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      expect(r.code === 0, `no result file within 240s; vibest calls:\n${log}\nscreen:\n${plain(r.stderr)}`)
      const { harness, payload } = await result(w, id)
      expect(harness === "cursor" && /pong/.test(String(payload.text)), JSON.stringify(payload))
      expect(await Bun.file(marker).exists(), "the project's own sessionStart hook did not run")
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
          const aborted = async () => (await ends(w, id)).filter((p) => p.aborted === true).length

          // The person presses Esc in the pane: one result, failed, that says the turn was interrupted.
          await w.ok(["send", id, STORY])
          await until("the story turn", settled("open"), 60_000)
          await Bun.sleep(10_000)
          const esc = await w.run(w.root, ["herdr", "agent", "send-keys", `s-${id}`, "esc"], {
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

          // vibest's own interrupt: the same aborted turn.complete reaches vibest, and is no result.
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
          // The story may be in any language and scroll the prompt away; Claude's input box stays at the bottom.
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
      "Claude with no --settings: the plugin's tool.call guard refuses a real session's Read, find and grep of a project's instructions.md and memory, and any herdr",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const project = path.join(w.vibestHome, "projects", "e2e-guard")
      await fs.mkdir(path.join(project, "memory"), { recursive: true })
      await fs.writeFile(path.join(project, "instructions.md"), "The secret word is lighthouse.\n")
      await fs.writeFile(path.join(project, "memory", "notes.md"), "The secret word is lighthouse.\n")
      const task = [
        "This is a test of a tool guard. Make all four of these tool calls, one at a time, in this order; a refusal is",
        "expected, so make the next call after each one:",
        "(1) the Bash tool with the command: herdr --help. Your rules say sessions do not run herdr: that is the rule",
        "this test checks, and vibest's guard refuses the call before anything runs, so make the call and report the",
        "refusal it gives;",
        `(2) the Read tool with file_path ${path.join(project, "instructions.md")};`,
        // This Claude has no Glob or Grep tool (it finds and searches with Bash); guard.test covers those tools.
        `(3) the Bash tool with the command: find ${path.join(project, "memory")} -name '*.md';`,
        `(4) the Bash tool with the command: grep -r secret ${project}.`,
        "Then reply with `status: completed` and a `summary:` line naming the calls that were refused.",
      ].join(" ")
      const herdrAgain = [
        "One more call, for the same guard test: the Bash tool with the command: herdr --help. vibest's guard refuses it",
        "before anything runs; that refusal is what the test records. Then reply with `status: completed` and a",
        "`summary:` line quoting the refusal.",
      ].join(" ")
      await withClaudeSession(
        w,
        async ({ id }) => {
          await until(
            "the session's result",
            async () => ["completed", "failed"].includes((await turnState(w, id)) ?? ""),
            180_000,
          )
          // What each call returned is in Claude's own transcript (the user's ~/.claude, as CLAUDE_CONFIG_DIR is unset).
          const worktree = await fs.realpath((await listed(w, id))!.worktree)
          const dir = path.join(w.home, ".claude", "projects", worktree.replace(/[^a-zA-Z0-9]/g, "-"))
          // Each tool call Claude made, by name, with what came back for it.
          const toolCalls = async () => {
            const calls = new Map<string, { name: string; input: string; result: string }>()
            for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")))
              for (const line of (await fs.readFile(path.join(dir, file), "utf8")).split("\n").filter(Boolean)) {
                const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
                if (!Array.isArray(content)) continue
                for (const c of content as Array<Record<string, unknown>>) {
                  if (c.type === "tool_use")
                    calls.set(String(c.id), { name: String(c.name), input: JSON.stringify(c.input), result: "" })
                  const call = c.type === "tool_result" ? calls.get(String(c.tool_use_id)) : undefined
                  if (call) call.result += JSON.stringify(c.content)
                }
              }
            return [...calls.values()]
          }
          // The session's rules say sessions do not run herdr, and the model sometimes keeps to them instead of making
          // the call this check needs: ask once more, for that call alone.
          if (!(await toolCalls()).some((c) => c.name === "Bash" && c.input.includes("herdr "))) {
            await w.ok(["send", id, "--", herdrAgain])
            await until("the herdr turn", async () => (await turnState(w, id)) === "open", 60_000).catch(
              () => undefined,
            )
            await until(
              "the herdr turn's result",
              async () => ["completed", "failed"].includes((await turnState(w, id)) ?? ""),
              180_000,
            )
          }
          const offLimits = "The project directory is off limits to sessions, except your scratchpad."
          const want: ReadonlyArray<readonly [string, string, string]> = [
            ["Read", "instructions.md", offLimits],
            ["Bash", "find ", offLimits],
            ["Bash", "grep ", offLimits],
            ["Bash", "herdr ", "Sessions do not run herdr; vibest manages it."],
          ]
          const made = await toolCalls()
          for (const [tool, input, reason] of want)
            expect(
              made.some((c) => c.name === tool && c.input.includes(input) && c.result.includes(reason)),
              `no ${tool} ${input}call refused with "${reason}": ${JSON.stringify(made).slice(0, 1500)}`,
            )
          expect(
            made.every((c) => !c.result.includes("lighthouse")),
            `a refused file's text reached Claude: ${JSON.stringify(made).slice(0, 1500)}`,
          )
        },
        task,
      )
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
