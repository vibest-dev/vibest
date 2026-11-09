import path from "node:path"

import type { World } from "./world.ts"
import { claudeShadow, FAKE_ANTHROPIC_KEY, piShadow } from "./world/shadow.ts"

export type Message = { role: string; content: unknown }

export type Step = { readonly tool: string; readonly input: Record<string, string> } | string

export const text = (m: Message | undefined) =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)

export const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`

const sseHeaders = { "content-type": "text/event-stream" }

const chunk = (o: object) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`

const done = (finish: string) =>
  chunk({
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) + "data: [DONE]\n\n"

const reply = (content: string) =>
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + done("stop")

const toolCall = (id: string, name: string, input: object) =>
  chunk({
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
        },
        finish_reason: null,
      },
    ],
  }) + done("tool_calls")

export const piDir = (w: World, name: string, url: string) =>
  piShadow(path.join(w.root, name), w.profile, { fake: { baseUrl: url } })

export const delegatingModel = (sub: string, options: { readonly heldMs?: number } = {}) => {
  const seen: Array<string> = []
  const answered: Array<{ readonly marker: string; readonly from: number; readonly to: number }> = []
  let sessionId = ""
  let calls = 0
  const bash = (command: string) => toolCall(`call${++calls}`, "bash", { command })
  const answer = (last: Message | undefined) => {
    const body = text(last)
    if (last?.role === "tool") {
      const id = /"id":\s*\\?"([\w-]+)\\?"/.exec(body)?.[1]
      if (id && !sessionId) sessionId = id
      return reply("ok")
    }
    if (body.includes("<agent-")) {
      if (body.includes("done-zero")) return bash(`vibest run ${sub} -- '${ask("one")}'`)
      if (body.includes("done-one")) return bash(`vibest send ${sessionId} -- '${ask("two")}'`)
      return reply("ok")
    }
    const task = /done-(\w+)/.exec(body)
    return task ? reply(`done-${task[1]}\nstatus: completed`) : reply("ok")
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      seen.push(`${messages.at(-1)?.role}: ${text(messages.at(-1))}`)
      const last = messages.at(-1)
      const marker = /done-(\w+)/.exec(text(last))?.[1]
      if (options.heldMs !== undefined && last?.role === "user") {
        const from = Date.now()
        await Bun.sleep(options.heldMs)
        if (marker !== undefined && !text(last).includes("<agent-")) answered.push({ marker, from, to: Date.now() })
      }
      return new Response(answer(last), { headers: sseHeaders })
    },
  })
  return {
    seen,
    answered,
    sessionId: () => sessionId,
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

export const heldModel = () => {
  const held: Array<() => void> = []
  const requestsPerTask = new Map<string, number>()
  let released = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const last = text(messages.at(-1))
      const task = last.includes("<agent-") ? null : /done-(\w+)/.exec(last)
      if (!task) return new Response(reply("ok"), { headers: sseHeaders })
      requestsPerTask.set(task[1]!, (requestsPerTask.get(task[1]!) ?? 0) + 1)
      const answer = reply(`done-${task[1]}\nstatus: completed`)
      if (released) return new Response(answer, { headers: sseHeaders })
      return new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(chunk({ choices: [{ index: 0, delta: { role: "assistant" } }] })))
            held.push(() => {
              try {
                c.enqueue(new TextEncoder().encode(answer))
                c.close()
              } catch {}
            })
          },
        }),
        { headers: sseHeaders },
      )
    },
  })
  return {
    held: () => held.length,
    asked: (task: string) => requestsPerTask.get(task) ?? 0,
    releaseOne: () => {
      held.shift()?.()
    },
    release: () => {
      released = true
      for (const go of held.splice(0)) go()
    },
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      for (const go of held.splice(0)) go()
      server.stop(true)
    },
  }
}

export const holdsSlowResultModel = () => {
  const seen: Array<ReadonlyArray<string>> = []
  const held: Array<() => void> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      seen.push(messages.map((m) => `${m.role}: ${text(m)}`))
      const last = text(messages.at(-1))
      if (last.includes("<agent-") && last.includes("done-slow"))
        return new Response(
          new ReadableStream({
            start: (c) =>
              void held.push(() => {
                try {
                  c.close()
                } catch {}
              }),
          }),
          { headers: sseHeaders },
        )
      const task = last.includes("<agent-") ? null : /done-(\w+)/.exec(last)
      return new Response(reply(task ? `done-${task[1]}\nstatus: completed` : "ok"), { headers: sseHeaders })
    },
  })
  return {
    seen,
    held: () => held.length,
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      for (const release of held) release()
      server.stop(true)
    },
  }
}

export const usageLimitedModel = (limited: (path: string) => boolean) => {
  const seen: Array<string> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const last = text(messages.at(-1))
      seen.push(`${new URL(req.url).pathname} ${last.slice(-80)}`)
      if (limited(new URL(req.url).pathname))
        return new Response(
          `data: ${JSON.stringify({ error: { message: "usage limit reached, try again later" } })}\n\n`,
          { headers: sseHeaders },
        )
      return new Response(reply(/done-limit/.test(last) ? "done-limit\nstatus: completed" : "ok"), {
        headers: sseHeaders,
      })
    },
  })
  return { seen, port: server.port, stop: () => server.stop(true) }
}

export const fakeOpenAI = (
  step: (who: string, dir: string, done: number, last: string | undefined) => Step,
  dirs: Record<string, string>,
) => {
  let calls = 0
  const answer = (s: Step) => (typeof s === "string" ? reply(s) : toolCall(`call${++calls}`, s.tool, s.input))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const system = text(messages.find((m) => m.role === "system" || m.role === "developer"))
      const main = /The project folder is (\S+) \(VIBEST_PROJECT_DIR\)/.exec(system)
      const sub = /Project folder: (\S+) \(VIBEST_PROJECT_DIR\)/.exec(system)
      const who = main ? "main" : sub ? "pi" : undefined
      const tools = messages.filter((m) => m.role === "tool")
      const last = messages.at(-1)
      const mainTurnNotStartedBySubagentResult = who === "main" && tools.length === 0 && !text(last).includes("<agent-")
      if (who === undefined || mainTurnNotStartedBySubagentResult)
        return new Response(answer("ok"), { headers: sseHeaders })
      if (tools.length > 3) return new Response(answer("ok"), { headers: sseHeaders })
      dirs[who] = (main ?? sub)![1]!
      const result = last?.role === "tool" ? text(last) : undefined
      return new Response(answer(step(who, dirs[who]!, tools.length, result)), { headers: sseHeaders })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

export type ToolResult = { readonly tool_use_id: string; readonly is_error?: boolean; readonly content: unknown }

export type AnthropicRequest = {
  readonly system: string
  readonly tools: ReadonlyArray<string>
  readonly messages: ReadonlyArray<Message>
  readonly results: ReadonlyArray<ToolResult>
}

export const subagentFolder = (system: string) => /Project folder: (\S+) \(VIBEST_PROJECT_DIR\)/.exec(system)?.[1]

export const lastUser = (r: AnthropicRequest) => r.messages.findLast((m) => m.role === "user")

export const resultText = (r: ToolResult) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content))

export const fakeAnthropic = (respond: (r: AnthropicRequest) => Step | Promise<Step>) => {
  let n = 0
  const requests: Array<AnthropicRequest> = []
  const sse = (events: ReadonlyArray<readonly [string, object]>) =>
    events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`).join("")
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method !== "POST" || !url.pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 })
      const body = (await req.json()) as {
        stream?: boolean
        system?: unknown
        tools?: Array<{ name?: string }>
        messages?: Array<Message>
      }
      const messages = body.messages ?? []
      const results = messages
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : []))
        .filter((b): b is ToolResult & { type: string } => b.type === "tool_result")
      const request: AnthropicRequest = {
        system: JSON.stringify(body.system ?? ""),
        tools: (body.tools ?? []).map((t) => t.name ?? ""),
        messages,
        results,
      }
      requests.push(request)
      const s = await respond(request)
      const content: Array<object> =
        typeof s === "string"
          ? [{ type: "text", text: s }]
          : [{ type: "tool_use", id: `toolu_${results.length}`, name: s.tool, input: s.input }]
      const stop = typeof s === "string" ? "end_turn" : "tool_use"
      const message = {
        id: `msg_${++n}`,
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content,
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
      if (!body.stream) return Response.json(message)
      const events: Array<readonly [string, object]> = [
        ["message_start", { message: { ...message, content: [], stop_reason: null } }],
      ]
      content.forEach((c, index) => {
        const block = c as { type: string; text?: string; id?: string; name?: string; input?: object }
        if (block.type === "text") {
          events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }])
          events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }])
        } else {
          events.push([
            "content_block_start",
            { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
          ])
          events.push([
            "content_block_delta",
            { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
          ])
        }
        events.push(["content_block_stop", { index }])
      })
      events.push(["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }])
      events.push(["message_stop", {}])
      return new Response(sse(events), { headers: sseHeaders })
    },
  })
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

export const claudeConfigOf = (flags: ReadonlyArray<string>) =>
  flags.find((f) => f.startsWith("CLAUDE_CONFIG_DIR="))!.slice("CLAUDE_CONFIG_DIR=".length)

export const claudeEnv = async (w: World, name: string, url: string, dir = path.join(w.root, `claude-${name}`)) => {
  await claudeShadow(dir, w.profile)
  return [`CLAUDE_CONFIG_DIR=${dir}`, `ANTHROPIC_BASE_URL=${url}`, `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}`].flatMap(
    (pair) => ["--env", pair],
  )
}
