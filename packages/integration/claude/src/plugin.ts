import { ACK_ROUTE, hookRoute, isPolled, POLL_ROUTE, type Polled, sessionHeaders } from "@vibest/protocol/protocol"
import type { EngineInterface, On, Register } from "claude-code"

declare const VIBEST_PLUGIN_VERSION: string

export const POLL_MS = 1000
export const POLL_FAILURES_SHOWN = 5
export const GUARD_TRY_MS = 2000
export const GUARD_BACKOFF_MS = [100, 300, 900] as const
export const REPORT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000] as const
export const REPORT_TRY_MS = 10_000
export const UNREACHABLE = "vibestd unreachable; the tool call is refused."
export const FULL_MAX = 100

type Reply = { readonly status: number; readonly body: unknown }
type Env =
  | "VIBEST_AGENT"
  | "VIBEST_SESSION_ID"
  | "VIBEST_PROJECT_ID"
  | "VIBEST_HARNESS"
  | "VIBEST_RUNTIME"
  | "VIBEST_HOME"
  | "HOME"

function nativeHost($: EngineInterface) {
  return {
    env: (name: Env) => {
      switch (name) {
        case "VIBEST_AGENT":
          return $.env.get("VIBEST_AGENT")
        case "VIBEST_SESSION_ID":
          return $.env.get("VIBEST_SESSION_ID")
        case "VIBEST_PROJECT_ID":
          return $.env.get("VIBEST_PROJECT_ID")
        case "VIBEST_HARNESS":
          return $.env.get("VIBEST_HARNESS")
        case "VIBEST_RUNTIME":
          return $.env.get("VIBEST_RUNTIME")
        case "VIBEST_HOME":
          return $.env.get("VIBEST_HOME")
        case "HOME":
          return $.env.get("HOME")
      }
    },
    conversation: () => $.session.id(),
    cwd: () => $.session.cwd(),
    plugin: () => $.plugin.name,
    fetch: (socketPath: string, path: string, headers: Record<string, string>, body: string) =>
      $.http.fetch(`http://vibestd${path}`, { method: "POST", socketPath, headers, body }),
    submit: (text: string) => $.prompt.submit({ text }),
    redraw: () => $.ui.invalidate("ui.render"),
    every: (ms: number, fn: () => void) => $.clock.every(ms, fn),
    after: (ms: number, fn: () => void) => $.clock.after(ms, fn),
    status: (text: string | undefined) => $.ui.status(text),
    claudeCodePid: async () => {
      const pid = Number((await $.process.run(["sh", "-c", 'echo "$PPID"'])).stdout.trim())
      return Number.isInteger(pid) && pid > 1 ? pid : undefined
    },
  }
}

type Host = ReturnType<typeof nativeHost>

const TOOL_CALL_RESERVED_KEYS = new Set(["tool", "tool_use_id", "consent", "agentId"])
const toolInput = (event: object): Record<string, unknown> => {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (!TOOL_CALL_RESERVED_KEYS.has(key)) input[key] = value
  }
  return input
}

const timeout = <T>(promise: Promise<T>, ms: number, after: Host["after"]) =>
  new Promise<T>((resolve, reject) => {
    const timer = after(ms, () => reject(new Error(`no answer in ${ms} ms`)))
    promise.then(
      (value) => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      },
    )
  })

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const errorOf = (body: unknown) =>
  typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : undefined

export function register(on: On, _options?: unknown) {
  const queue: Array<Polled> = []
  const seen = new Set<number>()
  const full = new Map<string, Array<string>>()
  let unacked: Array<number> = []
  let release: Array<number> = []
  let polling = false
  let draining = false
  let failures = 0
  let mismatched = false
  let timer: { cancel: () => void } | undefined

  const identity = async (host: Host) => {
    const agent = await host.env("VIBEST_AGENT")
    const sessionId = await host.env("VIBEST_SESSION_ID")
    if (!agent || !sessionId) return undefined
    const home = (await host.env("VIBEST_HOME")) || `${(await host.env("HOME")) ?? ""}/.vibest`
    return { agent, sessionId, socket: `${home}/vibest-http.sock` }
  }

  const post = async (host: Host, path: string, body: unknown, ms: number): Promise<Reply> => {
    const who = await identity(host)
    if (!who) throw new Error("not an VIBEST session")
    const headers = sessionHeaders({
      sessionId: who.sessionId,
      projectId: await host.env("VIBEST_PROJECT_ID"),
      harnessSessionId: await host.conversation().catch(() => undefined),
      agent: who.agent,
      harness: (await host.env("VIBEST_HARNESS")) || "claude",
      cwd: await host.cwd().catch(() => undefined),
      runtime: await host.env("VIBEST_RUNTIME"),
      pluginVersion: VIBEST_PLUGIN_VERSION,
    })
    const r = await timeout(
      host.fetch(who.socket, path, { ...headers, "content-type": "application/json" }, JSON.stringify(body)),
      ms,
      host.after,
    )
    const reply = { status: r.status, body: parse(r.text) }
    if (reply.status === 409) {
      mismatched = true
      host.status(`VIBEST: ${errorOf(reply.body) ?? "vibest was updated; run vibest update"}`)
    } else if (mismatched) {
      mismatched = false
      host.status(undefined)
    }
    return reply
  }

  const report = async (host: Host, path: string, body: unknown) => {
    const attempt = async (n: number): Promise<void> => {
      let retry = true
      try {
        const r = await post(host, path, body, REPORT_TRY_MS)
        retry = r.status >= 500
      } catch {}
      const pause = REPORT_BACKOFF_MS[n]
      if (retry && pause !== undefined) host.after(pause, () => void attempt(n + 1))
    }
    await attempt(0)
  }

  const tick = async (host: Host) => {
    if (polling) return
    polling = true
    try {
      if (unacked.length > 0 || release.length > 0) {
        const r = await post(host, ACK_ROUTE, { ids: unacked, release }, REPORT_TRY_MS)
        if (r.status === 200) {
          unacked = []
          release = []
        }
      }
      const r = await post(host, POLL_ROUTE, {}, REPORT_TRY_MS)
      if (r.status === 409) return
      if (r.status !== 200 || !isPolled(r.body)) throw new Error(errorOf(r.body) ?? `poll answered ${r.status}`)
      if (failures >= POLL_FAILURES_SHOWN) host.status(undefined)
      failures = 0
      const batch = r.body
      if (batch.ids.length === 0) return
      const queued = (id: number) => queue.some((b) => b.ids.includes(id))
      for (const id of batch.ids) if (seen.has(id) && !queued(id) && !unacked.includes(id)) unacked.push(id)
      const fresh = batch.ids.filter((id) => !seen.has(id))
      if (fresh.length === 0) return
      if (fresh.length < batch.ids.length) {
        release.push(...fresh)
        return
      }
      for (const id of batch.ids) seen.add(id)
      queue.push(batch)
      host.redraw()
    } catch {
      failures += 1
      if (failures === POLL_FAILURES_SHOWN) host.status("VIBEST: vibestd does not answer; still trying")
    } finally {
      polling = false
    }
  }

  const keep = (line: string, text: string) => {
    const list = full.get(line)
    if (list) list.push(text)
    else full.set(line, [text])
    while (full.size > FULL_MAX) full.delete(full.keys().next().value!)
  }
  const forget = (line: string, text: string) => {
    const list = full.get(line)
    const at = list?.lastIndexOf(text) ?? -1
    if (list && at >= 0) list.splice(at, 1)
    if (list?.length === 0) full.delete(line)
  }

  on("session.start", async ($, e, next) => {
    const host = nativeHost($)
    if (await identity(host).catch(() => undefined)) {
      const pid = await host.claudeCodePid().catch(() => undefined)
      void report(host, "/session/ready", pid === undefined ? {} : { pid })
    }
    if (timer === undefined && (await identity(host))?.agent === "coordinator") {
      timer = host.every(POLL_MS, () => void tick(host))
      void tick(host)
    }
    return next(e)
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const batch = queue[0]
    if (batch !== undefined && !draining) {
      const host = nativeHost($)
      draining = true
      queue.shift()
      keep(batch.line, batch.text)
      host.submit(batch.line).then(
        (r) => {
          draining = false
          if (r.drop !== undefined) {
            forget(batch.line, batch.text)
            queue.unshift(batch)
          } else unacked.push(...batch.ids)
          if (queue.length > 0) host.redraw()
        },
        () => {
          draining = false
          forget(batch.line, batch.text)
          queue.unshift(batch)
          host.redraw()
        },
      )
    }
    return next(e)
  })

  on("turn.complete", async ($, event, next) => {
    if (event.agentId === undefined) {
      const host = nativeHost($)
      const who = await identity(host).catch(() => undefined)
      if (who && who.agent !== "coordinator")
        void report(host, hookRoute("claude", "turn-end"), {
          hook_event_name: "TurnComplete",
          session_id: await host.conversation().catch(() => ""),
          reason: event.reason,
          last_assistant_message: event.answer,
          ...(event.reason === "refusal" ? { refusal: event.refusal } : {}),
        })
    }
    return next(event)
  })

  on("prompt.submit", async ($, event, next) => {
    const host = nativeHost($)
    if (event.origin.kind === "plugin" && event.origin.name === host.plugin()) {
      const list = full.get(event.text)
      const text = list?.shift()
      if (list?.length === 0) full.delete(event.text)
      if (text === undefined || event.text.trimEnd().endsWith(text.trim())) return next(event)
      return next({ ...event, context: [...(event.context ?? []), text] })
    }
    const who = await identity(host).catch(() => undefined)
    if (who && who.agent !== "coordinator")
      await report(host, hookRoute("claude", "prompt"), {
        hook_event_name: "PromptSubmit",
        text: event.text,
        origin: event.origin.kind,
      })
    return next(event)
  })

  on("tool.call", async ($, event, next) => {
    const host = nativeHost($)
    if (!(await host.env("VIBEST_AGENT"))) return next(event)
    const body = { tool_name: event.tool, tool_input: toolInput(event), cwd: await host.cwd() }
    for (let n = 0; ; n++) {
      try {
        const r = await post(host, hookRoute("claude", "guard"), body, GUARD_TRY_MS)
        if (r.status === 200) {
          const deny = (r.body as { deny?: unknown } | undefined)?.deny
          return typeof deny === "string" ? { deny } : next(event)
        }
        if (r.status < 500) return { deny: `vibest refused the tool call: ${errorOf(r.body) ?? `status ${r.status}`}` }
      } catch {}
      const pause = GUARD_BACKOFF_MS[n]
      if (pause === undefined) return { deny: UNREACHABLE }
      await new Promise<void>((resolve) => host.after(pause, resolve))
    }
  }).catch(async ($, event, next) => {
    try {
      if (!(await nativeHost($).env("VIBEST_AGENT"))) return undefined
    } catch {
      return undefined
    }
    if (next.called) return next(event)
    return { deny: UNREACHABLE }
  })
}

type _Assert<T extends true> = T
type _MatchesRegister = _Assert<typeof register extends Register ? true : false>
