import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { checkout, expect, row, Skip, until } from "../world.ts"

type CoreTerminal = { address: string; reported: boolean; status?: { state: string; kind?: string; app?: string } }

const fakeAnthropic = () => {
  const waiting: Array<(text: string) => void> = []
  const stages: Array<{ at: number; event: string }> = []
  const answer = (text: string) => {
    const message = {
      id: "msg_status",
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const events = [
      ["message_start", { message }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", {}],
    ] as const
    return new Response(
      events
        .map(([event, data]) => "event: " + event + "\ndata: " + JSON.stringify({ type: event, ...data }) + "\n\n")
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      if (!new URL(req.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 })
      const body = (await req.json()) as { tools?: Array<unknown>; stream?: boolean }
      if (!body.stream)
        return Response.json({
          id: "msg_aux",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      if (!body.tools?.length) return answer("ok")
      stages.push({ at: Date.now(), event: "model waiting" })
      return answer(await new Promise<string>((resolve) => waiting.push(resolve)))
    },
  })
  return { url: "http://127.0.0.1:" + server.port, waiting, stages, stop: () => server.stop(true) }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "T1",
    title: "Claude's native OSC 7501 reports working, done and interrupted idle in an isolated herdr-core",
    run: async (w, evidence) => {
      for (const bin of ["hc", "claude"]) if (!Bun.which(bin)) throw new Skip(bin + " not on PATH")
      const model = fakeAnthropic()
      const home = path.join(w.root, "home")
      const env = {
        HOME: home,
        HC_SESSION: "status",
        HC_SOCKET: path.join(w.root, "hc.sock"),
        HC_TERMINAL: "",
        HC_MACHINE: "",
        XDG_STATE_HOME: path.join(w.root, "state"),
        XDG_CONFIG_HOME: path.join(w.root, "config"),
        XDG_RUNTIME_DIR: path.join(w.root, "runtime"),
        ZDOTDIR: path.join(w.root, "zdot"),
        CLAUDE_CONFIG_DIR: w.config.claude,
        ANTHROPIC_BASE_URL: model.url,
        ANTHROPIC_API_KEY: "sk-ant-e2e-fake-0123456789abcdefghijklmnop",
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: undefined,
        SHELL: "/bin/sh",
      }
      for (const dir of [
        home,
        env.XDG_STATE_HOME,
        env.XDG_CONFIG_HOME,
        env.XDG_RUNTIME_DIR,
        env.ZDOTDIR,
        path.join(env.XDG_CONFIG_HOME, "herdr-core"),
      ])
        await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(env.XDG_CONFIG_HOME, "herdr-core/config.toml"), "notes = false\n")
      await fs.writeFile(
        path.join(w.config.claude, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
        }),
      )
      await fs.writeFile(
        path.join(w.config.claude, "settings.json"),
        JSON.stringify({
          disableAutoMode: "disable",
          permissions: { defaultMode: "default", disableAutoMode: "disable" },
        }),
      )
      const plugin = path.join(w.vibestHome, "plugins/status-runtime.ts")
      await fs.mkdir(path.dirname(plugin), { recursive: true })
      await fs.copyFile(path.join(checkout, "tools/e2e/src/fixtures/status-runtime.ts"), plugin)
      const hc = async (...args: Array<string>) => {
        const r = await w.run(w.root, ["hc", ...args], { env })
        expect(r.code === 0, "isolated hc " + args.join(" ") + ": " + r.stderr)
        return r.stdout
      }
      const snapshots: Array<{ at: number; stage: string; terminal: CoreTerminal }> = []
      let terminal = ""
      const status = async (stage: string, state: string) => {
        let current: CoreTerminal | undefined
        await until(
          stage,
          async () => {
            current = JSON.parse(await hc("get", terminal)) as CoreTerminal
            return current.reported && current.status?.state === state
          },
          30_000,
        )
        snapshots.push({ at: Date.now(), stage, terminal: current! })
        expect(
          current!.status?.app === "claude-code",
          "status was not Claude's native record: " + JSON.stringify(current),
        )
      }
      await w.stopDaemon()
      try {
        await hc("server", "start")
        await w.ok(["daemon"], { env })
        const launched = await w.json<{ id: string }>(
          ["run", "claude", "--model", "haiku", "--", "Reply with the supplied model response; use no tools."],
          { env, timeoutMs: 90_000 },
        )
        await until(
          "Claude terminal bound",
          () => {
            const saved = row<{ terminal: string }>(
              w,
              "SELECT json_extract(data, '$.terminal') AS terminal FROM event WHERE session_id = ? AND type = 'process.start' AND json_extract(data, '$.terminal') != '' ORDER BY at DESC LIMIT 1",
              launched.id,
            )
            terminal = saved?.terminal.split("/").at(-1) ?? ""
            return terminal !== ""
          },
          60_000,
        )
        await until("held Claude request", () => model.waiting.length === 1, 30_000)
        await status("held model", "working")
        model.waiting.shift()!("native-status-completed")
        await status("successful turn", "done")
        await until(
          "unchanged vibest result",
          async () =>
            JSON.stringify(await w.json(["result", launched.id], { env })).includes("native-status-completed"),
          30_000,
        )
        await hc("send", terminal, "Start another turn and wait for the model.")
        await until("second held request", () => model.waiting.length === 1, 30_000)
        await status("next turn", "working")
        await hc("keys", terminal, "esc")
        await status("interrupted turn", "idle")
        const screen = await hc("read", terminal)
        expect(!screen.includes("7501;"), "OSC bytes appeared as visible text")
        await fs.writeFile(path.join(evidence, "T1-screen.txt"), screen)
      } finally {
        await fs.writeFile(
          path.join(evidence, "T1-status.json"),
          JSON.stringify({ snapshots, model: model.stages }, null, 2),
        )
        model.stop()
        await w.stopDaemon()
        await hc("server", "stop")
        await fs.rm(plugin)
      }
    },
  },
]

export default checks
