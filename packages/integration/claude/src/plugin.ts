import { hookRoute, isTaken, sessionHeaders, TAKE_ROUTE } from "@vibest/protocol/protocol"
import { formatDelivery, type Taken } from "@vibest/schema/session"
import type { EngineInterface, On, Register, ToolCallInput } from "claude-code"
import * as Predicate from "effect/Predicate"

declare const VIBEST_PLUGIN_VERSION: string

export const POLL_MS = 1000
export const POLL_FAILURES_SHOWN = 5
export const GUARD_TRY_MS = 2000
export const GUARD_BACKOFF_MS = [100, 300, 900] as const
export const REPORT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000] as const
export const REPORT_TRY_MS = 10_000
export const UNREACHABLE = "vibestd unreachable; the tool call is refused."
export const FULL_MAX = 100

export const shown = (detail: Taken["detail"]) => formatDelivery(detail)

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

type Reply = { readonly status: number; readonly body: Json | undefined }

type Env =
  | "VIBEST_SESSION_ID"
  | "VIBEST_PROJECT_ID"
  | "VIBEST_HARNESS"
  | "VIBEST_RUNTIME"
  | "VIBEST_HOME"
  | "VIBEST_PROCESS"
  | "VIBEST_EXECUTION"
  | "HOME"

function nativeHost($: EngineInterface) {
  return {
    env: (name: Env) => {
      switch (name) {
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
        case "VIBEST_PROCESS":
          return $.env.get("VIBEST_PROCESS")
        case "VIBEST_EXECUTION":
          return $.env.get("VIBEST_EXECUTION")
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

const toolInput = (event: ToolCallInput) =>
  Object.fromEntries(Object.entries(event).filter(([key]) => !TOOL_CALL_RESERVED_KEYS.has(key)))

const timeout = <T>(promise: Promise<T>, ms: number, after: Host["after"]) =>
  new Promise<T>((resolve, reject) => {
    const timer = after(ms, () => reject(new Error(`no answer in ${ms} ms`)))
    promise.then(
      (value) => {
        timer.cancel()
        resolve(value)
      },
      (cause: unknown) => {
        timer.cancel()
        reject(cause)
      },
    )
  })

const parse = (text: string): Json | undefined => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isFields = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  value instanceof Object && !Array.isArray(value)

const member = (body: Json | undefined, name: string) => (isFields(body) ? body[name] : undefined)

const errorOf = (body: Json | undefined) => {
  const error = member(body, "error")

  return Predicate.isString(error) ? error : undefined
}

const parseExecution = (raw: string | undefined) => {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined
  const parsed = Number(raw)

  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function register(on: On) {
  const queue: Array<Taken> = []
  const full = new Map<string, Array<Taken>>()
  let idle = false
  let polling = false
  let draining = false
  let failures = 0
  let mismatched = false
  let timer: { cancel: () => void } | undefined
  let processId: string | undefined
  let bound: number | undefined
  let initialPending: number | undefined
  let initialBoundRead = false

  const ensureInitialBound = async (host: Host) => {
    if (initialBoundRead) return
    initialBoundRead = true
    const initial = parseExecution(await host.env("VIBEST_EXECUTION").catch(() => undefined))

    if (bound === undefined && initial !== undefined) {
      bound = initial
      initialPending = initial
    }
  }

  const identity = async (host: Host) => {
    const sessionId = await host.env("VIBEST_SESSION_ID")

    if (!sessionId) return undefined
    const home = (await host.env("VIBEST_HOME")) || `${(await host.env("HOME")) ?? ""}/.vibest`

    return { sessionId, socket: `${home}/vibest-http.sock` }
  }

  const post = async <Body>(host: Host, path: string, body: Body, ms: number): Promise<Reply> => {
    const who = await identity(host)

    if (!who) throw new Error("not an VIBEST session")

    const headers = sessionHeaders({
      sessionId: who.sessionId,
      projectId: await host.env("VIBEST_PROJECT_ID"),
      harnessSessionId: await host.conversation().catch(() => undefined),
      harness: (await host.env("VIBEST_HARNESS")) || "claude",
      cwd: await host.cwd().catch(() => undefined),
      runtime: await host.env("VIBEST_RUNTIME"),
      pluginVersion: VIBEST_PLUGIN_VERSION,
      process: processId ?? (await host.env("VIBEST_PROCESS")),
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

  const report = async <Body>(host: Host, path: string, body: Body, answered?: (body: Json | undefined) => void) => {
    const attempt = async (n: number): Promise<void> => {
      let retry = true

      try {
        const r = await post(host, path, body, REPORT_TRY_MS)
        retry = r.status >= 500

        if (r.status === 200) answered?.(r.body)
      } catch {}

      const pause = REPORT_BACKOFF_MS[n]

      if (retry && pause !== undefined) host.after(pause, () => void attempt(n + 1))
    }

    await attempt(0)
  }

  const tick = async (host: Host) => {
    if (polling || !idle || draining || queue.length > 0) return
    polling = true

    try {
      const r = await post(host, TAKE_ROUTE, {}, REPORT_TRY_MS)

      if (r.status === 409) return

      if (r.status !== 200 && r.status !== 204) throw new Error(errorOf(r.body) ?? `take answered ${r.status}`)

      if (failures >= POLL_FAILURES_SHOWN) host.status(undefined)
      failures = 0

      if (r.status === 204) return

      if (!isTaken(r.body)) throw new Error("take answered an unknown shape")
      queue.push(r.body)
      host.redraw()
    } catch {
      failures += 1

      if (failures === POLL_FAILURES_SHOWN) host.status("VIBEST: vibestd does not answer; still trying")
    } finally {
      polling = false
    }
  }

  const keep = (line: string, taken: Taken) => {
    const list = full.get(line)

    if (list) list.push(taken)
    else full.set(line, [taken])

    while (full.size > FULL_MAX) full.delete(full.keys().next().value!)
  }

  const forget = (line: string, execution: number) => {
    const list = full.get(line)
    const at = list?.findLastIndex((taken) => taken.execution === execution) ?? -1

    if (list && at >= 0) list.splice(at, 1)

    if (list?.length === 0) full.delete(line)
  }

  on("session.start", async ($, e, next) => {
    const host = nativeHost($)
    await ensureInitialBound(host)

    if (await identity(host).catch(() => undefined)) {
      const pid = await host.claudeCodePid().catch(() => undefined)
      void report(host, "/session/ready", pid === undefined ? {} : { pid }, (body) => {
        const current = member(body, "process")

        if (Predicate.isNumber(current)) processId = String(current)
      })

      if (bound !== undefined)
        void report(host, hookRoute("claude", "prompt"), {
          hook_event_name: "PromptSubmit",
          origin: "vibest",
          execution: bound,
        })
    }

    idle = bound === undefined

    if (timer === undefined && (await identity(host))) {
      timer = host.every(POLL_MS, () => void tick(host))

      if (idle) void tick(host)
    }

    return next(e)
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const batch = queue[0]

    if (batch !== undefined && !draining) {
      const host = nativeHost($)
      draining = true
      queue.shift()
      const line = shown(batch.detail)
      keep(line, batch)
      await host.submit(line).then(
        (r) => {
          draining = false

          if (r.drop !== undefined) {
            forget(line, batch.execution)
            void report(host, hookRoute("claude", "prompt"), {
              hook_event_name: "PromptSubmit",
              origin: "vibest",
              execution: batch.execution,
              refused: true,
            })
          }

          if (queue.length > 0) host.redraw()
        },
        () => {
          draining = false
          forget(line, batch.execution)
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
      idle = true
      await ensureInitialBound(host)

      const execution = bound
      bound = undefined
      initialPending = undefined

      if (who)
        void report(host, hookRoute("claude", "execution-end"), {
          hook_event_name: "ExecutionComplete",
          session_id: await host.conversation().catch(() => ""),
          reason: event.reason,
          last_assistant_message: event.answer,
          ...(execution !== undefined && { execution }),
          ...(event.reason === "refusal" && { refusal: event.refusal }),
        })
    }

    return next(event)
  })

  on("prompt.submit", async ($, event, next) => {
    const host = nativeHost($)
    idle = false

    if (event.origin.kind === "plugin" && event.origin.name === host.plugin()) {
      const list = full.get(event.text)
      const taken = list?.shift()

      if (list?.length === 0) full.delete(event.text)

      if (taken === undefined) return next(event)
      initialBoundRead = true
      initialPending = undefined
      bound = taken.execution
      await report(host, hookRoute("claude", "prompt"), {
        hook_event_name: "PromptSubmit",
        origin: "vibest",
        execution: taken.execution,
        ids: taken.ids,
      })

      if (event.text.trimEnd().endsWith(taken.content.trim())) return next(event)

      return next({ ...event, context: [...(event.context ?? []), taken.content] })
    }

    await ensureInitialBound(host)

    if (event.origin.kind === "composer" && initialPending !== undefined) {
      initialPending = undefined

      return next(event)
    }

    if (event.origin.kind === "composer" || event.origin.kind === "bridge") {
      initialPending = undefined
      bound = undefined
    }

    const who = await identity(host).catch(() => undefined)

    if (who)
      await report(host, hookRoute("claude", "prompt"), {
        hook_event_name: "PromptSubmit",
        text: event.text,
        origin: event.origin.kind,
      })

    return next(event)
  })

  on("tool.call", async ($, event, next) => {
    const host = nativeHost($)

    if (!(await host.env("VIBEST_SESSION_ID"))) return next(event)
    const body = { tool_name: event.tool, tool_input: toolInput(event), cwd: await host.cwd() }

    for (let n = 0; ; n++) {
      try {
        const r = await post(host, hookRoute("claude", "guard"), body, GUARD_TRY_MS)

        if (r.status === 200) {
          const deny = member(r.body, "deny")

          return Predicate.isString(deny) ? { deny } : next(event)
        }

        if (r.status < 500) return { deny: `vibest refused the tool call: ${errorOf(r.body) ?? `status ${r.status}`}` }
      } catch {}

      const pause = GUARD_BACKOFF_MS[n]

      if (pause === undefined) return { deny: UNREACHABLE }
      await new Promise<void>((resolve) => host.after(pause, resolve))
    }
  }).catch(async ($, event, next) => {
    try {
      if (!(await nativeHost($).env("VIBEST_SESSION_ID"))) return undefined
    } catch {
      return undefined
    }

    if (next.called) return next(event)

    return { deny: UNREACHABLE }
  })
}

type _Assert<T extends true> = T

type _MatchesRegister = _Assert<typeof register extends Register ? true : false>
