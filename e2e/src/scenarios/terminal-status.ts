import fs from "node:fs/promises"
import path from "node:path"

import { Predicate, type Schema } from "effect"

import type { Check } from "../check.ts"
import { binary, checkout, expect, row, Skip, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"

type Reply = string | { tool: string; input: Schema.JsonObject } | { error: string }

const fakeModel = () => {
  const waiting: Array<(reply: Reply) => void> = []
  const stages: Array<{ at: number; event: string }> = []
  let sequence = 0

  const answer = (reply: Reply, openAI = false) => {
    if (!Predicate.isString(reply) && "error" in reply)
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: reply.error } },
        { status: 401 },
      )
    const text = Predicate.isString(reply)

    const block = text
      ? { type: "text", text: "" }
      : { type: "tool_use", id: "toolu_status_" + ++sequence, name: reply.tool, input: {} }

    const delta = text
      ? { type: "text_delta", text: reply }
      : { type: "input_json_delta", partial_json: JSON.stringify(reply.input) }

    if (openAI) {
      const chunk = (delta: Schema.JsonObject, finish: string | null = null) =>
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

      const delta = Predicate.isString(reply)
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
      stages.push({ at: Date.now(), event: Predicate.isString(reply) ? reply : JSON.stringify(reply) })
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
    readonly worker: (harness: string, flags?: Array<string>) => Promise<string>
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
  await fs.copyFile(path.join(checkout, "e2e/src/fixtures/status-pty.py"), path.join(w.root, "status-pty.py"))
  const plugin = path.join(w.vibestHome, "plugins/status-runtime.ts")

  const hc = async (...args: Array<string>) => {
    const r = await w.run(w.root, ["hc", ...args], { env })
    expect(r.code === 0, "isolated hc " + args.join(" ") + ": " + r.stderr)

    return r.stdout
  }

  let terminal = ""

  const bind = async (sessionId: string) => {
    await until(
      "harness terminal bound",
      () => {
        const saved = row<{ terminal: string }>(
          w,
          `SELECT CASE WHEN json_valid(terminal) THEN coalesce(terminal ->> '$.id', terminal) ELSE terminal END AS terminal
            FROM process WHERE session_id = ? AND coalesce(terminal, '') != '' ORDER BY id DESC LIMIT 1`,
          sessionId,
        )

        terminal = saved?.terminal.split("/").at(-1) ?? ""

        return terminal !== ""
      },
      60_000,
    )
  }

  const worker = async (harness: string, flags: Array<string> = []) => {
    const launched = JSON.parse(
      await w.okViaEntry(["run", harness, ...flags, "--", "Run the terminal status fixture."], {
        env,
        timeoutMs: 90_000,
      }),
    ) as { id: string }

    await bind(launched.id)

    return launched.id
  }

  await w.stopDaemon()

  try {
    await hc("server", "start")
    await w.ok(["daemon"], { env })
    w.ownRuntimes.add("hc")
    await w.entry({
      runtime: "hc",
      extra: ["--runtime", "hc"],
      processEnv: env,
      hc: { run: (...args) => w.run(w.root, ["hc", ...args], { env }) },
    })
    await fs.mkdir(path.dirname(plugin), { recursive: true })
    await fs.copyFile(path.join(checkout, "e2e/src/fixtures/status-runtime.ts"), plugin)
    await until(
      "the status-fixture plugin active",
      async () =>
        (await w.json<Array<{ id: string; status: string }>>(["plugins"], { env })).some(
          (p) => p.id === "status-fixture" && p.status === "active",
        ),
      30_000,
    )
    await body({
      env,
      model,
      hc,
      terminal: () => terminal,
      worker,
    })
    await w.writeEvidence(
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
    await w.writeEvidence(path.join(evidence, `${id}-status.json`), JSON.stringify({ model: model.stages }, null, 2))
    model.stop()
    await w.stopDaemon()
    await hc("server", "stop").catch((error) => console.error("Failed to stop isolated herdr-core:", error))
    await w.copyEvidence(path.join(w.root, "status-output"), path.join(evidence, `${id}-pty`))
    await fs.rm(plugin)
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "G7",
    title:
      "a user plugin adds a runtime (over an isolated herdr-core) and routes a Pi subagent to it: the subagent starts in that runtime's terminal and its result arrives",
    run: (w, evidence) =>
      statusCore(w, evidence, "G7", "pi", async ({ env, model, hc, terminal, worker }) => {
        const piConfig = await piShadow(path.join(w.root, "pi-status"), "first-run", {
          fake: { baseUrl: model.url + "/v1" },
        })

        const pi = await worker("pi", [
          "--provider",
          "fake",
          "--model",
          "m",
          "--env",
          "PI_CODING_AGENT_DIR=" + piConfig,
        ])

        await model.next("pi-status-completed")
        await until(
          "the Pi subagent's result",
          async () =>
            (await w.json<{ reply: { text: string } | null }>(["result", pi], { env })).reply?.text.includes(
              "pi-status-completed",
            ) === true,
          60_000,
        )
        await hc("kill", terminal())
      }),
  },
]

export default checks
