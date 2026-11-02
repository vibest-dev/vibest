// vibest's plugin for each harness ships with vibest (apps/vibest-herdr/harnesses, VIBEST_HARNESSES) and is loaded into each
// harness vibest starts, for that session only: Pi `-e`, Claude and Cursor `--plugin-dir`. Nothing is installed, and the
// user's own plugins and hooks keep loading beside it. Each check runs the real harness with the user's own login and
// config (read, not written) and a temp VIBEST_HOME: an agent's herdr call is refused, and its reply lands as the result.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Check } from "../check.ts"
import { binary, compiled, expect, harnesses, Skip, until, type World } from "../world.ts"

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

/** A session's live status as `vibest ls` shows it. */
const status = async (w: World, id: string) =>
  (await w.json<Array<{ id: string; status: string }>>(["ls"])).find((e) => e.id === id)?.status

/**
 * One real Claude session (`vibest run claude`) on a long answer, in a herdr session of its own, with the user's own Claude
 * login: vibestd is started anew without CLAUDE_CONFIG_DIR, as S12 does, and the herdr session gets its environment.
 * Archives the session and stops that herdr session at the end.
 */
const withClaudeSession = async (w: World, body: (s: { id: string; socket: string }) => Promise<void>) => {
  const session = `${w.herdrSession}-claude`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  await w.stopDaemon()
  await w.ok(["daemon"], { env: { CLAUDE_CONFIG_DIR: undefined } })
  let id = ""
  try {
    const run = await w.ok(
      [
        "run",
        "claude",
        "--model",
        "haiku",
        "--session",
        session,
        "--",
        "Do not use any tools. Write a very long story, at least 4000 words, about a lighthouse keeper.",
      ],
      { timeoutMs: 120_000 },
    )
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
      "the plugins ship with vibest: one directory per harness; `integration` has only the hooks' guard, prompt and stop, nothing to install",
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
        JSON.stringify(subcommands) === JSON.stringify(["guard", "prompt", "stop"]),
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
      expect(harness === "claude" && /pong/.test(String(payload.last_assistant_message)), JSON.stringify(payload))
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
        { env: { VIBEST_AGENT: "general", VIBEST_SESSION_ID: id, PATH: `${bin}:${w.env().PATH}` }, timeoutMs: 300_000 },
      )
      const log = await fs.readFile(calls, "utf8").catch(() => "")
      expect(
        /^integration guard --harness cursor => .*"permission":"deny".*herdr/m.test(log),
        `no guard refusal recorded:\n${log}\nscreen:\n${plain(r.stderr)}`,
      )
      expect(!(await Bun.file(path.join(cwd, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
      expect(r.code === 0, `no result file within 240s; vibest calls:\n${log}\nscreen:\n${plain(r.stderr)}`)
      const { harness, payload } = await result(w, id)
      expect(
        harness === "cursor" && payload.hook_event_name === "afterAgentResponse" && /pong/.test(String(payload.text)),
        JSON.stringify(payload),
      )
      expect(await Bun.file(marker).exists(), "the project's own sessionStart hook did not run")
    },
  },
  {
    id: "I7",
    title:
      "Claude: an interactive turn stopped with Esc fires no Stop; the built plugin's turn.complete reports it once, as an interrupted (failed) result",
    run: async (w) => {
      for (const bin of ["tmux", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // tmux, not herdr: a herdr pane's login shell puts the user's own `vibest` ahead of this build on PATH, and the
      // plugin's hooks run `vibest` from PATH. tmux runs the command with `sh -c`, which keeps the build first.
      const cwd = await workdir(w, "claude-esc")
      const id = "e2e00007"
      const tmux = (...args: Array<string>) =>
        w.run(cwd, ["tmux", "-L", path.basename(w.root), ...args], { env: { CLAUDE_CONFIG_DIR: undefined } })
      const screen = async () => (await tmux("capture-pane", "-p", "-t", "esc")).stdout
      const lines = async () =>
        (await fs.readFile(path.join(w.vibestHome, "reports", `${id}.jsonl`), "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { turn: string; payload?: Record<string, unknown> })
      const env = [
        `VIBEST_HOME=${w.vibestHome}`,
        "VIBEST_AGENT=general",
        `VIBEST_SESSION_ID=${id}`,
        `PATH=${path.dirname(binary)}:$PATH`,
        "CLAUDECODE=",
        "CLAUDE_CODE_ENTRYPOINT=",
      ].join(" ")
      try {
        const claude = `claude --plugin-dir ${path.join(harnesses, "claude")} --model haiku`
        const started = await tmux("new-session", "-d", "-s", "esc", "-x", "200", "-y", "50", `env ${env} ${claude}`)
        expect(started.code === 0, `tmux: ${started.stderr}`)
        await until("Claude's prompt", async () => /trust this folder|❯/.test(await screen()), 60_000)
        if (/trust this folder/.test(await screen())) await tmux("send-keys", "-t", "esc", "Down", "Enter")
        await Bun.sleep(3_000)
        const story = "Do not use any tools. Write a very long story, at least 4000 words, about a lighthouse keeper."
        await tmux("send-keys", "-t", "esc", "-l", story)
        await tmux("send-keys", "-t", "esc", "Enter")
        await until("the turn's start line", async () => (await lines()).some((l) => l.turn === "start"), 60_000)
        // Let the answer stream for a moment, then press Esc as the user would.
        await Bun.sleep(8_000)
        await tmux("send-keys", "-t", "esc", "Escape")
        await until("a turn-end line", async () => (await lines()).some((l) => l.turn === "end"), 30_000).catch(
          async (e: Error) => {
            throw new Error(`${e.message}; screen:\n${await screen()}`)
          },
        )
        await Bun.sleep(3_000)
        const ends = (await lines()).filter((l) => l.turn === "end")
        expect(ends.length === 1, `turn ends: ${JSON.stringify(ends).slice(0, 1000)}`)
        const payload = ends[0]!.payload!
        expect(
          payload.hook_event_name === "TurnComplete" && payload.reason === "aborted",
          `not a TurnComplete aborted: ${JSON.stringify(payload).slice(0, 500)}`,
        )
        const { payload: written } = await result(w, id)
        expect(
          written.error === "interrupted" &&
            written.error_details === "the turn was stopped in its terminal (Esc) before it ended",
          `result file: ${JSON.stringify(written).slice(0, 500)}`,
        )
      } finally {
        await tmux("kill-server")
      }
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
