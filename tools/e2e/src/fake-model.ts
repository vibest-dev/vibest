// A fake model for the agents a check starts, on 127.0.0.1: OpenAI chat completions (`/v1/chat/completions`, Pi through a
// models.json provider) and Anthropic Messages (`/v1/messages`, Claude Code through ANTHROPIC_BASE_URL), both streamed.
// A check answers each turn request with a text reply or one shell tool call; the conversation it reads is the same for
// both: user, assistant and tool messages as plain text.
import fs from "node:fs/promises"
import path from "node:path"

/**
 * One message of a request's conversation. `tool` is a tool's output (Anthropic sends it in a user message, as a
 * `tool_result`). Claude Code sends some context as system messages in the conversation (prompt.submit hook context).
 */
export type Message = { readonly role: "system" | "user" | "assistant" | "tool"; readonly text: string }
/** A reply, or one call of the agent's shell tool (Pi `bash`, Claude `Bash`). */
export type Answer = { readonly text: string } | { readonly bash: string }
export type Api = "openai" | "anthropic"

type Block = { type?: string; text?: string; content?: unknown; input?: unknown }
const blocks = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Array<Block>)
          .map((b) =>
            b.type === "tool_result"
              ? blocks(b.content)
              : b.type === "tool_use"
                ? JSON.stringify(b.input)
                : (b.text ?? ""),
          )
          .join("")
      : ""

const fromOpenAI = (messages: Array<{ role: string; content: unknown }>): Array<Message> =>
  messages.map((m) => ({ role: m.role as Message["role"], text: blocks(m.content) }))

const fromAnthropic = (messages: Array<{ role: string; content: unknown }>): Array<Message> =>
  messages.map((m) => ({
    role:
      m.role === "user" && Array.isArray(m.content) && (m.content as Array<Block>).some((b) => b.type === "tool_result")
        ? "tool"
        : (m.role as Message["role"]),
    text: blocks(m.content),
  }))

let calls = 0
const sse = (event: string | undefined, data: object) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`

const openai = (a: Answer) => {
  const chunk = (o: object) =>
    sse(undefined, { id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })
  const delta =
    "text" in a
      ? { role: "assistant", content: a.text }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call${++calls}`,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: a.bash }) },
            },
          ],
        }
  return (
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "text" in a ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) +
    "data: [DONE]\n\n"
  )
}

const anthropic = (a: Answer, stream: boolean) => {
  const id = `toolu_${++calls}`
  const block =
    "text" in a ? { type: "text", text: a.text } : { type: "tool_use", id, name: "Bash", input: { command: a.bash } }
  const stop = "text" in a ? "end_turn" : "tool_use"
  const usage = { input_tokens: 1, output_tokens: 1 }
  const message = { id: `msg_${calls}`, type: "message", role: "assistant", model: "fake", stop_sequence: null }
  if (!stream) return JSON.stringify({ ...message, content: [block], stop_reason: stop, usage })
  return [
    sse("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage } }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: "text" in a ? { type: "text", text: "" } : { ...block, input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta:
        "text" in a
          ? { type: "text_delta", text: a.text }
          : { type: "input_json_delta", partial_json: JSON.stringify({ command: a.bash }) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage }),
    sse("message_stop", { type: "message_stop" }),
  ].join("")
}

/**
 * The fake model. `answer` gets each turn request's conversation; Claude Code's side requests (a title, a summary: no
 * tools offered) get "ok" without it. A held answer (`answer` awaiting) keeps that agent mid-turn.
 */
export const fakeServer = (answer: (messages: Array<Message>, api: Api) => Answer | Promise<Answer>) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A held answer may take longer than Bun's default 10 s.
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method !== "POST") return new Response("{}", { headers: { "content-type": "application/json" } })
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: unknown }>
        tools?: Array<unknown>
        stream?: boolean
      }
      if (url.pathname.endsWith("/chat/completions"))
        return new Response(openai(await answer(fromOpenAI(body.messages ?? []), "openai")), {
          headers: { "content-type": "text/event-stream" },
        })
      if (url.pathname.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 1 })
      if (url.pathname.endsWith("/messages")) {
        const turn = (body.tools?.length ?? 0) > 0
        const a = turn ? await answer(fromAnthropic(body.messages ?? []), "anthropic") : { text: "ok" }
        return new Response(anthropic(a, body.stream === true), {
          headers: { "content-type": body.stream ? "text/event-stream" : "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  return { url: `${url}/v1`, anthropic: url, stop: () => server.stop(true) }
}

/** A PI_CODING_AGENT_DIR (under `root`) whose only model is the fake one at `url`. */
export const piDir = async (root: string, name: string, url: string) => {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: url,
          apiKey: "fake",
          api: "openai-completions",
          models: [{ id: "m", contextWindow: 100_000, maxTokens: 1000 }],
        },
      },
    }),
  )
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }))
  return dir
}

/**
 * A CLAUDE_CONFIG_DIR (under `root`) for Claude Code on the fake model at `base`: onboarding done, nothing of the user's
 * login or settings. The environment Claude gets it with, for vibestd (whose panes inherit it).
 */
export const claudeEnv = async (root: string, name: string, base: string) => {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", lastOnboardingVersion: "9.9.9" }),
  )
  // Auto mode off: it would ask a classifier (this fake model) about each tool call, and Claude shows dialogs about it
  // (its billing on a gateway, making it the default). vibest's own --allowedTools already let its agents' commands run.
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default", disableAutoMode: "disable" } }),
  )
  return {
    CLAUDE_CONFIG_DIR: dir,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: "fake",
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
}
