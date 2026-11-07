import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { binary, checkout, copyEvidence, expect, row, Skip, until, type World, writeEvidence } from "../world.ts"
import { piShadow } from "../world/shadow.ts"

type CoreTerminal = { address: string; reported: boolean; status?: { state: string; kind?: string; app?: string } }

const reports = (bytes: string) =>
  bytes
    .split("\x1b]7501;")
    .slice(1)
    .map((record) => record.split("\x1b")[0]!.split("\x07")[0]!)

type Reply = string | { tool: string; input: object } | { error: string }

const fakeModel = () => {
  const waiting: Array<(reply: Reply) => void> = []
  const stages: Array<{ at: number; event: string }> = []
  let sequence = 0
  const answer = (reply: Reply, openAI = false) => {
    if (typeof reply !== "string" && "error" in reply)
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: reply.error } },
        { status: 401 },
      )
    const text = typeof reply === "string"
    const block = text
      ? { type: "text", text: "" }
      : { type: "tool_use", id: "toolu_status_" + ++sequence, name: reply.tool, input: {} }
    const delta = text
      ? { type: "text_delta", text: reply }
      : { type: "input_json_delta", partial_json: JSON.stringify(reply.input) }
    if (openAI) {
      const chunk = (delta: object, finish: string | null = null) =>
        "data: " +
        JSON.stringify({
          id: "status",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "\n\n"
      const delta =
        typeof reply === "string"
          ? { role: "assistant", content: reply }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_" + sequence,
                  type: "function",
                  function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
                },
              ],
            }
      return new Response(chunk(delta) + chunk({}, text ? "stop" : "tool_calls") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    }
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
      ["content_block_start", { index: 0, content_block: block }],
      ["content_block_delta", { index: 0, delta }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        { delta: { stop_reason: text ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
      ],
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
      const url = new URL(req.url)
      const openAI = url.pathname.endsWith("/chat/completions")
      if (!openAI && !url.pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 })
      const body = (await req.json()) as {
        tools?: Array<{ name?: string; function?: { name?: string } }>
        stream?: boolean
        model?: string
        messages?: Array<unknown>
      }
      if (!body.stream)
        return Response.json({
          id: "msg_aux",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      if (!body.tools?.some((tool) => ["Bash", "read"].includes(tool.name ?? tool.function?.name ?? "")))
        return answer("ok", openAI)
      if (JSON.stringify(body.messages?.at(-1)).includes("[SUGGESTION MODE:")) return answer("", openAI)
      stages.push({ at: Date.now(), event: "model waiting " + body.model })
      return answer(await new Promise<Reply>((resolve) => waiting.push(resolve)), openAI)
    },
  })
  return {
    url: "http://127.0.0.1:" + server.port,
    waiting,
    stages,
    next: async (reply: Reply) => {
      await until("next model request", () => waiting.length > 0, 30_000)
      stages.push({ at: Date.now(), event: typeof reply === "string" ? reply : JSON.stringify(reply) })
      waiting.shift()!(reply)
    },
    stop: () => server.stop(true),
  }
}

const statusCore = async (
  w: World,
  evidence: string,
  id: string,
  harness: "claude" | "pi",
  body: (t: {
    readonly env: Record<string, string | undefined>
    readonly model: ReturnType<typeof fakeModel>
    readonly hc: (...args: Array<string>) => Promise<string>
    readonly terminal: () => string
    readonly visible: (text: string) => Promise<void>
    readonly status: (stage: string, state: string, kind?: string) => Promise<void>
    readonly worker: (harness: string, flags?: Array<string>) => Promise<string>
    readonly snapshot: (stage: string, terminal: CoreTerminal) => void
  }) => Promise<void>,
) => {
  for (const bin of ["hc", harness, "python3"]) if (!Bun.which(bin)) throw new Skip(bin + " not on PATH")
  const model = fakeModel()
  const home = path.join(w.root, "home")
  const env = {
    HOME: home,
    HC_SESSION: "status",
    HC_SOCKET: path.join(w.root, "hc.sock"),
    HC_TERMINAL_ID: undefined,
    HC_MACHINE: undefined,
    XDG_STATE_HOME: path.join(w.root, "state"),
    XDG_CONFIG_HOME: path.join(w.root, "config"),
    XDG_RUNTIME_DIR: path.join(w.root, "runtime"),
    ZDOTDIR: path.join(w.root, "zdot"),
    CLAUDE_CONFIG_DIR: w.config.claude,
    PI_CODING_AGENT_DIR: path.join(w.root, "pi-status"),
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: "sk-ant-e2e-fake-0123456789abcdefghijklmnop",
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: undefined,
    SHELL: "/bin/sh",
    PI_PROGRAM_STATUS: undefined,
    PATH: path.join(w.root, "bin") + ":" + w.env().PATH,
    PI_PACKAGE_DIR: await fs.realpath(path.join(w.home, ".pix/current")).catch(() => undefined),
  }
  for (const dir of [
    home,
    env.XDG_STATE_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_RUNTIME_DIR,
    env.ZDOTDIR,
    path.join(env.XDG_CONFIG_HOME, "herdr-core"),
    path.join(w.root, "status-output"),
    path.join(w.root, "bin"),
  ])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (env.PI_PACKAGE_DIR) await fs.symlink(path.join(env.PI_PACKAGE_DIR, "pi"), path.join(w.root, "bin/pi"))
  await fs.writeFile(path.join(env.XDG_CONFIG_HOME, "herdr-core/config.toml"), "notes = false\n")
  await fs.writeFile(
    path.join(w.config.claude, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
      projects: { [await fs.realpath(w.repository)]: { hasTrustDialogAccepted: true } },
    }),
  )
  await fs.writeFile(
    path.join(w.config.claude, "settings.json"),
    JSON.stringify({
      disableAutoMode: "disable",
      permissions: { defaultMode: "default", disableAutoMode: "disable", ask: ["Bash"] },
    }),
  )
  const plugin = path.join(w.vibestHome, "plugins/status-runtime.ts")
  await fs.mkdir(path.dirname(plugin), { recursive: true })
  await fs.copyFile(path.join(checkout, "tools/e2e/src/fixtures/status-runtime.ts"), plugin)
  await fs.copyFile(path.join(checkout, "tools/e2e/src/fixtures/status-pty.py"), path.join(w.root, "status-pty.py"))
  const hc = async (...args: Array<string>) => {
    const r = await w.run(w.root, ["hc", ...args], { env })
    expect(r.code === 0, "isolated hc " + args.join(" ") + ": " + r.stderr)
    return r.stdout
  }
  const visible = (text: string) =>
    until(
      "stable visible " + text,
      async () => {
        const first = await hc("read", terminal)
        if (!first.includes(text)) return false
        await Bun.sleep(300)
        return (await hc("read", terminal)) === first
      },
      30_000,
    )
  const snapshots: Array<{ at: number; stage: string; terminal: CoreTerminal }> = []
  let terminal = ""
  let owner: string | undefined = harness === "pi" ? "pi" : "claude-code"
  const status = async (stage: string, state: string, kind?: string) => {
    let current: CoreTerminal | undefined
    await until(
      stage,
      async () => {
        current = JSON.parse(await hc("get", terminal)) as CoreTerminal
        return current.reported && current.status?.state === state && current.status?.kind === kind
      },
      30_000,
    )
    snapshots.push({ at: Date.now(), stage, terminal: current! })
    expect(current!.status?.app === owner, "unexpected status owner: " + JSON.stringify(current))
  }
  const bind = async (sessionId: string) => {
    await until(
      "harness terminal bound",
      () => {
        const saved = row<{ terminal: string }>(
          w,
          "SELECT json_extract(data, '$.terminal') AS terminal FROM event WHERE session_id = ? AND type = 'process.start' AND json_extract(data, '$.terminal') != '' ORDER BY at DESC LIMIT 1",
          sessionId,
        )
        terminal = saved?.terminal.split("/").at(-1) ?? ""
        return terminal !== ""
      },
      60_000,
    )
  }
  const worker = async (harness: string, flags: Array<string> = []) => {
    const launched = await w.json<{ id: string }>(
      ["run", harness, ...flags, "--", "Run the terminal status fixture."],
      { env, timeoutMs: 90_000 },
    )
    await bind(launched.id)
    return launched.id
  }
  await w.stopDaemon()
  try {
    await hc("server", "start")
    await w.ok(["daemon"], { env })
    await body({
      env,
      model,
      hc,
      terminal: () => terminal,
      visible,
      status,
      worker,
      snapshot: (stage, current) => snapshots.push({ at: Date.now(), stage, terminal: current }),
    })
    owner = undefined
    for (const file of await fs.readdir(path.join(w.root, "status-output"))) {
      if (!file.endsWith(".raw")) continue
      const records = reports(await fs.readFile(path.join(w.root, "status-output", file), "utf8")).filter((r) =>
        r.startsWith("state="),
      )
      expect(
        records.every((r) => r === "state=clear" || r.includes(":app=pi") || r.includes(":app=claude-code")),
        "competing terminal writer: " + JSON.stringify(records),
      )
    }
    await writeEvidence(
      path.join(evidence, `${id}-versions.json`),
      JSON.stringify(
        {
          claude: (await w.run(w.root, ["claude", "--version"], { env })).stdout,
          pi: (await w.run(w.root, ["pi", "--version"], { env })).stdout,
          hc: await hc("--version"),
          vibest: (await w.run(w.root, [binary, "--version"], { env })).stdout,
        },
        null,
        2,
      ),
    )
  } finally {
    await writeEvidence(
      path.join(evidence, `${id}-status.json`),
      JSON.stringify({ snapshots, model: model.stages }, null, 2),
    )
    model.stop()
    await w.stopDaemon()
    await hc("server", "stop").catch((error) => console.error("Failed to stop isolated herdr-core:", error))
    await copyEvidence(path.join(w.root, "status-output"), path.join(evidence, `${id}-pty`))
    await fs.rm(plugin)
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "T1-claude",
    title: "native Claude statuses in an isolated herdr-core",
    run: (w, evidence) =>
      statusCore(
        w,
        evidence,
        "T1-claude",
        "claude",
        async ({ env, model, hc, terminal, visible, status, worker, snapshot }) => {
          const launched = { id: await worker("claude", ["--model", "haiku"]) }
          await until("held Claude request", () => model.waiting.length === 1, 30_000)
          await status("held model", "working")
          const approved = path.join(w.root, "approved.txt")
          await model.next({
            tool: "Bash",
            input: { command: "printf approved > " + approved, description: "Write the E2E scratch marker" },
          })
          await status("permission dialog", "blocked", "permission")
          expect(!(await Bun.file(approved).exists()), "scratch action ran before permission")
          const completed = () =>
            row<{ n: number }>(
              w,
              "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.end'",
              launched.id,
            )!.n
          expect(completed() === 0, "blocked published a completed result")
          await visible("Do you want to proceed?")
          await Bun.sleep(1000)
          await hc("keys", terminal(), "enter")
          await until("approved scratch action", () => Bun.file(approved).exists(), 30_000)
          await until("held response after approval", () => model.waiting.length === 1, 30_000)
          await status("permission resolved", "working")
          await model.next({
            tool: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Choose a scratch color",
                  header: "Color",
                  options: [
                    { label: "Blue", description: "First scratch choice" },
                    { label: "Green", description: "Second scratch choice" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          })
          await status("question dialog", "blocked", "question")
          expect(completed() === 0, "question published a completed result")
          await visible("Choose a scratch color")
          await writeEvidence(path.join(evidence, "T1-claude-question.txt"), await hc("read", terminal()))
          await Bun.sleep(1000)
          await hc("keys", terminal(), "enter")
          await until("held response after question", () => model.waiting.length === 1, 30_000)
          await status("question answered", "working")
          await model.next("native-status-completed")
          await status("successful turn", "done")
          await until(
            "unchanged vibest result",
            async () =>
              JSON.stringify(await w.json(["result", launched.id], { env })).includes("native-status-completed"),
            30_000,
          )
          const conversation = row<{ conversation: string }>(
            w,
            "SELECT json_extract(data, '$.resume') AS conversation FROM event WHERE session_id = ? AND type = 'process.start' ORDER BY at DESC LIMIT 1",
            launched.id,
          )!.conversation
          await visible("native-status-completed")
          await hc("send", terminal(), "/clear")
          await until(
            "clear removes the previous answer",
            async () => !(await hc("read", terminal())).includes("native-status-completed"),
            30_000,
          )
          await visible("/clear")
          await status("clear after done", "idle")
          await hc("send", terminal(), "/resume " + conversation)
          await visible("native-status-completed")
          await status("resumed conversation", "idle")
          await hc("send", terminal(), "Start another turn and wait for the model.")
          await until("second held request", () => model.waiting.length === 1, 30_000)
          await status("next turn", "working")
          await hc("keys", terminal(), "esc")
          await status("interrupted turn", "idle")
          await model.next("discard interrupted response")
          const denied = path.join(w.root, "denied.txt")
          await hc("send", terminal(), "Test a denied scratch action.")
          await model.next({
            tool: "Bash",
            input: { command: "printf denied > " + denied, description: "Scratch action to deny" },
          })
          await status("permission to deny", "blocked", "permission")
          await visible("Do you want to proceed?")
          await Bun.sleep(1000)
          await hc("keys", terminal(), "esc")
          await status("denied permission", "idle")
          expect(!(await Bun.file(denied).exists()), "denied scratch action executed")
          await hc("send", terminal(), "Test a dismissed question.")
          await model.next({
            tool: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Dismiss this scratch question",
                  header: "Dismiss",
                  options: [
                    { label: "One", description: "First choice" },
                    { label: "Two", description: "Second choice" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          })
          await status("question to dismiss", "blocked", "question")
          await visible("Dismiss this scratch question")
          await Bun.sleep(1000)
          await hc("keys", terminal(), "esc")
          await status("dismissed question", "idle")
          await hc("send", terminal(), "Hold the model while vibestd is down.")
          await until("model held during daemon outage", () => model.waiting.length === 1, 30_000)
          await w.stopDaemon()
          await status("daemon down during model request", "working")
          await model.next("native-status-without-daemon")
          await status("native completion without daemon", "done")
          await w.ok(["daemon"], { env })
          const screen = await hc("read", terminal())
          expect(!screen.includes("7501;"), "OSC bytes appeared as visible text")
          await writeEvidence(path.join(evidence, "T1-claude-screen.txt"), screen)
          await worker("claude", ["--model", "haiku"])
          await model.next({ error: "invalid x-api-key" })
          let auth: CoreTerminal | undefined
          await until(
            "native authentication outcome",
            async () => {
              auth = JSON.parse(await hc("get", terminal())) as CoreTerminal
              return (
                auth.reported &&
                (["blocked", "error"].includes(auth.status?.state ?? "") ||
                  (await hc("read", terminal())).includes("Retrying"))
              )
            },
            30_000,
          )
          snapshot("HTTP 401 authentication_error", auth!)
          await writeEvidence(path.join(evidence, "T1-claude-auth.txt"), await hc("read", terminal()))
          await hc("kill", terminal())
          for (const resolve of model.waiting.splice(0)) resolve("discard authentication retry")
          for (const [name, flag] of [
            ["title disabled", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1"],
            ["query unanswered", "VIBEST_STATUS_NO_QUERY=1"],
          ]) {
            await worker("claude", ["--model", "haiku", "--env", flag!])
            await model.next("negative-case-completed")
            await visible("negative-case-completed")
            const current = JSON.parse(await hc("get", terminal())) as CoreTerminal
            expect(!current.reported, name + " unexpectedly reported status")
            snapshot(name!, current)
            await hc("kill", terminal())
          }
        },
      ),
  },
  {
    id: "T1-pi",
    title: "native Pi statuses in an isolated herdr-core",
    run: (w, evidence) =>
      statusCore(w, evidence, "T1-pi", "pi", async ({ env, model, hc, terminal, visible, status, worker }) => {
        const piConfig = await piShadow(path.join(w.root, "pi-status"), "first-run", {
          fake: { baseUrl: model.url + "/v1" },
        })
        await fs.mkdir(path.join(piConfig, "extensions"))
        await fs.copyFile(
          path.join(checkout, "tools/e2e/src/fixtures/status-prompts.ts"),
          path.join(piConfig, "extensions/status-prompts.ts"),
        )
        const pi = await worker("pi", [
          "--provider",
          "fake",
          "--model",
          "m",
          "--env",
          "PI_CODING_AGENT_DIR=" + piConfig,
        ])
        await until("Pi model held", () => model.waiting.length === 1, 30_000)
        await status("Pi start", "working")
        await model.next({ tool: "status_prompt", input: {} })
        await status("Pi confirmation", "blocked", "permission")
        await visible("Confirm the scratch test")
        await hc("keys", terminal(), "enter")
        await until("Pi resumed model", () => model.waiting.length === 1, 30_000)
        await status("Pi resumed", "working")
        await model.next("pi-status-completed")
        await status("Pi settled", "done")
        expect(
          JSON.stringify(await w.json(["result", pi], { env })).includes("pi-status-completed"),
          "Pi result changed",
        )
        await hc("send", terminal(), "Wait for the model, then interrupt.")
        await until("Pi abort request held", () => model.waiting.length === 1, 30_000)
        await status("Pi before abort", "working")
        await hc("keys", terminal(), "esc")
        await status("Pi interrupted", "idle")
        await model.next("discard interrupted Pi response")
        await hc("send", terminal(), "/status-input")
        await status("Pi idle input", "blocked", "question")
        await visible("Scratch input")
        await hc("keys", terminal(), "esc")
        await status("Pi input dismissed", "idle")
        await hc("kill", terminal())
      }),
  },
]

export default checks
