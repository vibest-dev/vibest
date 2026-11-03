/**
 * The Claude Code hooks module of VIBEST, bundled to hooks/register.mjs by scripts/build.ts. Everything it says to
 * vibest goes over vibestd's HTTP socket (`$VIBEST_HOME/vibest-http.sock`, packages/server/src/http.ts) with the shared
 * session headers (@vibest/protocol `sessionHeaders`): no `vibest` process, no files.
 *
 * - `turn.complete`, `prompt.submit` and `tool.call` for every VIBEST session (VIBEST_AGENT and VIBEST_SESSION_ID set):
 *   the turn end, the person's prompt and the tool guard. turn.complete fires for every main-loop turn end (reason
 *   answer, aborted, refusal or error; Stop fires for no Esc) and carries no API error kind.
 * - The main agent's inbox (VIBEST_AGENT=coordinator): a poll every POLL_MS only queues what vibestd hands out. The
 *   AbovePrompt render hook submits one queued batch per draw as its one line; this module's own prompt.submit hook
 *   attaches the batch's full text as context to that line. (A submit from outside a hook's call stack, as a clock
 *   callback is, would skip this module's own prompt.submit hook as re-entry.) The batch is acked on the next poll. A
 *   batch that mixes rows already taken with new ones (handed out again after a lease ran out or vibestd restarted):
 *   the taken ones are acked and the new ones given back, so they come alone and no text is shown twice.
 *
 * /clear fires session.end with the old conversation and no new session.start; the clock keeps running and
 * `$.session.id()` answers the new conversation, so nothing stops on session.end and every request sends the current id.
 *
 * Types: `import type` from `claude-code`. The declarations are a local ignored cache, not a vendored file.
 * Pin: anthropics/claude-code 2eff7a8d21c80be48904f62ebdea36d945d7b504 (mods/types/claude-code.d.ts).
 * The AbovePrompt render hook as a place to submit from is undocumented; E2E covers it.
 */
import { ACK_ROUTE, hookRoute, isPolled, POLL_ROUTE, type Polled, sessionHeaders } from "@vibest/protocol/protocol"
import type { EngineInterface, On, Register } from "claude-code"

/** This plugin's version, inlined by scripts/build.ts (Claude Code's `$.plugin` has no version). */
declare const VIBEST_PLUGIN_VERSION: string

export const POLL_MS = 1000
/** Consecutive failed polls before the status line says vibestd is unreachable. */
export const POLL_FAILURES_SHOWN = 5
/** One guard try; then the next after these pauses; then the call is refused. */
export const GUARD_TRY_MS = 2000
export const GUARD_BACKOFF_MS = [100, 300, 900] as const
/** A turn end or prompt that did not get through is tried again after these pauses (about a minute in all). */
export const REPORT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000] as const
export const REPORT_TRY_MS = 10_000
export const UNREACHABLE = "vibestd unreachable; the tool call is refused."
/** At most this many lines keep their full text waiting for the prompt.submit hook. */
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

/**
 * Every native call this module makes, bound to one hook's `$`. Claude Code statically checks a hooks module: `$` may
 * be passed only to a top-level function declaration of the same file, so the helpers inside `register` get these
 * callbacks, never `$` itself.
 */
function nativeHost($: EngineInterface) {
  return {
    // The loader wants a literal name at each $.env.get, so the variables a module reads can be listed.
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
    // A command this process runs has it as its parent: Claude Code's own pid, which a restart signals.
    pid: async () => {
      const pid = Number((await $.process.run(["sh", "-c", 'echo "$PPID"'])).stdout.trim())
      return Number.isInteger(pid) && pid > 1 ? pid : undefined
    },
  }
}

type Host = ReturnType<typeof nativeHost>

/** Keys a tool.call input carries beside the tool's own arguments (ToolCallReserved and AgentLoop). */
const RESERVED = new Set(["tool", "tool_use_id", "consent", "agentId"])
/** Tool arguments on a tool.call input: every field except the reserved ones. */
const toolInput = (event: object): Record<string, unknown> => {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (!RESERVED.has(key)) input[key] = value
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

// A top-level function declaration: Claude Code's loader accepts `register` in no other shape.
export function register(on: On, _options?: unknown) {
  // The main agent's inbox, this module only. `queue`: batches polled, not yet submitted. `seen`: ids taken (queued or
  // submitted), so a batch handed out again after its lease ran out is not shown twice. `full`: per line, the full
  // texts waiting for the prompt.submit hook, oldest first. `unacked`: submitted, acked on the next poll. `release`: new
  // rows of a mixed batch, given back on the next ack.
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

  /** The session's identity from its environment, or undefined outside VIBEST. */
  const identity = async (host: Host) => {
    const agent = await host.env("VIBEST_AGENT")
    const sessionId = await host.env("VIBEST_SESSION_ID")
    if (!agent || !sessionId) return undefined
    const home = (await host.env("VIBEST_HOME")) || `${(await host.env("HOME")) ?? ""}/.vibest`
    return { agent, sessionId, socket: `${home}/vibest-http.sock` }
  }

  /** One request to vibestd. Throws when nothing answered (no socket, connection refused, timeout). */
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
    // Another protocol: vibestd says what to run. Shown until a request goes through again.
    if (reply.status === 409) {
      mismatched = true
      host.status(`VIBEST: ${errorOf(reply.body) ?? "vibest was updated; run vibest update"}`)
    } else if (mismatched) {
      mismatched = false
      host.status(undefined)
    }
    return reply
  }

  /** Report `body` to `path`; when vibestd does not take it, again after each REPORT_BACKOFF_MS pause. Never throws. */
  const report = async (host: Host, path: string, body: unknown) => {
    const attempt = async (n: number): Promise<void> => {
      let retry = true
      try {
        const r = await post(host, path, body, REPORT_TRY_MS)
        retry = r.status >= 500
      } catch {
        // Nothing answered: try again.
      }
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
      // Taken before (still queued here, or submitted and its ack lost): acked once submitted.
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

  /** Keep `text` for the prompt.submit hook under `line`; the oldest lines go past FULL_MAX. */
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
    // The harness takes input now: vibestd waits for this before it hands it a turn (rpc.ts Session.Ready).
    if (await identity(host).catch(() => undefined)) {
      const pid = await host.pid().catch(() => undefined)
      void report(host, "/session/ready", pid === undefined ? {} : { pid })
    }
    if (timer === undefined && (await identity(host))?.agent === "coordinator") {
      timer = host.every(POLL_MS, () => void tick(host))
      void tick(host)
    }
    return next(e)
  })

  // One batch per draw, submitted from inside this hook so this module's own prompt.submit hook sees it. Draws nothing.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const batch = queue[0]
    if (batch !== undefined && !draining) {
      const host = nativeHost($)
      draining = true
      queue.shift()
      keep(batch.line, batch.text)
      // Started here, inside the hook; its answer is handled when it comes, without holding the draw.
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

  // Side effect only. A failed report still returns next(e): never block or continue a stopped turn. A subagent's turn
  // (agentId set) is not the session's; the main agent's has no result (its conversation id goes with every poll).
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

  // This module's own submit (a polled batch's line): its full text goes with it as context. Anything else is reported;
  // vibestd keeps only what the person submitted (origin composer or bridge), and never the main agent's.
  on("prompt.submit", async ($, event, next) => {
    const host = nativeHost($)
    if (event.origin.kind === "plugin" && event.origin.name === host.plugin()) {
      const list = full.get(event.text)
      const text = list?.shift()
      if (list?.length === 0) full.delete(event.text)
      if (text !== undefined) return next({ ...event, context: [...(event.context ?? []), text] })
      return next(event)
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
      } catch {
        // Nothing answered in time: try again.
      }
      const pause = GUARD_BACKOFF_MS[n]
      if (pause === undefined) return { deny: UNREACHABLE }
      await new Promise<void>((resolve) => host.after(pause, resolve))
    }
  }).catch(async ($, event, next) => {
    // A failed hook is skipped unless this handler answers. Outside VIBEST that skip must stay a pass.
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
