type Message = { role: string; content: unknown }

const delay = Number(process.env.DEMO_MODEL_DELAY_MS ?? "4000")
const log = process.env.DEMO_MODEL_LOG
const task = `Reply with exactly two lines: the first is "done-demo", the second is "status: completed".`

const text = (m: Message | undefined) =>
  m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
const chunk = (o: object) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`
const done = (finish: string) =>
  chunk({
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) + "data: [DONE]\n\n"
const reply = (content: string) =>
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) + done("stop")
let calls = 0
const bash = (command: string) =>
  chunk({
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call${++calls}`,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }) + done("tool_calls")

const answer = (last: Message | undefined) => {
  const body = text(last)
  if (last?.role === "tool") return reply("The subagent is on it.")
  if (body.includes("<agent-")) return reply("The subagent finished: done-demo.")
  if (/done-demo/.test(body)) return reply("done-demo\nstatus: completed")
  if (/delegate/i.test(body)) return bash(`vibest run pi -- '${task}'`)
  return reply(`You said: ${body.slice(0, 200)}`)
}

const server = Bun.serve({
  port: Number(process.env.DEMO_MODEL_PORT ?? "0"),
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: async (req) => {
    const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
    const last = messages.at(-1)
    if (log)
      await Bun.write(
        log,
        `${await Bun.file(log)
          .text()
          .catch(() => "")}${last?.role}: ${text(last).slice(0, 300)}\n`,
      )
    await Bun.sleep(delay)
    return new Response(answer(last), { headers: { "content-type": "text/event-stream" } })
  },
})

console.log(`http://127.0.0.1:${server.port}/v1`)
