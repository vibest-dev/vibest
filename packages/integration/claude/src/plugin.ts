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
 *   attaches the batch's full text as context to that line and, once the line entered, acks the batch at once. (A
 *   submit from outside a hook's call stack, as a clock callback is, would skip this module's own prompt.submit hook as
 *   re-entry.) A batch that mixes rows already taken with new ones (handed out again after a lease ran out or vibestd
 *   restarted): the taken ones are acked and the new ones given back, so they come alone and no text is shown twice.
 *
 * Reload-safe (.agents/rules/update-restart.md 10): vibestd rewrites this file in place when it starts on a new
 * version, and Claude Code loads the new module when the running turn ends or at the next turn start, never mid-tool.
 * - What must outlive a reload is in the session's `$.state` (`Saved`; it survives a reload, and each Claude process
 *   has its own): the inbox's queue, the rows taken and not yet acked, and the reports vibestd did not take.
 * - Only the newest load polls: session.start writes its generation, and an older load still alive after a reload (one
 *   of its hooks still running) stops at its next tick. Every write is compare-and-set, so an old load never undoes one.
 * - What must finish is awaited inside a hook: the turn end, the prompt report and the ack. Fire-and-forget work dies
 *   with an old load (its request is sent, its `.then` never runs); a report not taken is kept and sent again.
 * - A later version keeps every native call this one makes (`nativeHost`): after a reload, an old load's calls are
 *   checked against the new module's.
 *
 * /clear fires session.end with the old conversation and no new session.start; the clock keeps running and
 * `$.session.id()` answers the new conversation, so nothing stops on session.end and every request sends the current id.
 * `$.state` starts empty for the new conversation: the next tick claims it again (rows it held wait out their lease).
 *
 * Types: `import type` from `claude-code`. The declarations are a local ignored cache, not a vendored file.
 * Pin: anthropics/claude-code 2eff7a8d21c80be48904f62ebdea36d945d7b504 (mods/types/claude-code.d.ts). `$.state` is
 * not in the pin; `Stateful` declares what this module uses of it (Claude Code 2.1.316 and 2.1.317 take it so).
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
/** At most this many reports wait to be sent again, and this many row ids are remembered as taken. */
export const REPORTS_MAX = 50
export const SEEN_MAX = 1000

type Reply = { readonly status: number; readonly body: unknown }
type Env =
  | "VIBEST_AGENT"
  | "VIBEST_SESSION_ID"
  | "VIBEST_PROJECT_ID"
  | "VIBEST_HARNESS"
  | "VIBEST_RUNTIME"
  | "VIBEST_HOME"
  | "HOME"

/** A report vibestd did not take yet. */
type Pending = { readonly n: string; readonly path: string; readonly body: unknown }

/**
 * What a reload must not lose, under `$.state` `{ plugin: "vibest", key: "inbox" }`. `queue`: batches polled, not yet
 * submitted. `inflight`: submitted, not yet seen entering. `seen`: ids taken, so a batch handed out again after its
 * lease ran out is not shown twice. `unacked`: shown, not yet acked. `release`: new rows of a mixed batch, given back
 * on the next ack. `reports`: reports to send again.
 */
export type Saved = {
  readonly generation: string
  readonly queue: ReadonlyArray<Polled>
  readonly inflight: ReadonlyArray<Polled>
  readonly seen: ReadonlyArray<number>
  readonly unacked: ReadonlyArray<number>
  readonly release: ReadonlyArray<number>
  readonly reports: ReadonlyArray<Pending>
}
const EMPTY: Saved = { generation: "", queue: [], inflight: [], seen: [], unacked: [], release: [], reports: [] }

/** What this module uses of `$.state`, which the pinned declarations do not have: per Claude process, kept across reloads. */
type Stateful = {
  readonly state: {
    get: (ref: { plugin: "vibest"; key: "inbox" }) => Promise<{ value?: unknown; version: number }>
    set: (
      ref: { plugin: "vibest"; key: "inbox" },
      value: Saved,
      options: { ifVersion: number },
    ) => Promise<{ isSet: boolean; version: number }>
  }
}

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
    // `plugin` and `key` must be literals at each call (Claude Code's static check).
    load: () => ($ as unknown as Stateful).state.get({ plugin: "vibest", key: "inbox" }),
    save: (value: Saved, ifVersion: number) =>
      ($ as unknown as Stateful).state.set({ plugin: "vibest", key: "inbox" }, value, { ifVersion }),
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

/** A saved record as read back, any field missing (another version's) filled in. */
const savedOf = (value: unknown): Saved =>
  typeof value === "object" && value !== null ? { ...EMPTY, ...(value as Partial<Saved>) } : EMPTY

const sameBatch = (a: Polled, b: Polled) => a.line === b.line && a.ids.join() === b.ids.join()

// A top-level function declaration: Claude Code's loader accepts `register` in no other shape.
export function register(on: On, _options?: unknown) {
  // This load's own: which load it is, and what it does right now. The rest is `saved`, mirrored in `$.state`.
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let saved: Saved = EMPTY
  let version = 0
  let polling = false
  let draining = false
  let flushing = false
  let failures = 0
  let mismatched = false
  let timer: { cancel: () => void } | undefined

  /** Read `$.state` into `saved`; false when a newer load polls now. Without `$.state`, `saved` is kept in memory only. */
  const load = async (host: Host) => {
    const r = await host.load().catch(() => undefined)
    if (r === undefined) return true
    saved = savedOf(r.value)
    version = r.version
    return saved.generation === "" || saved.generation === generation
  }

  /**
   * Apply `change` to the saved record, compare-and-set: on a miss it reads again and applies it to what stands, so an
   * old load still finishing a hook never undoes a newer one's write. A refused write is kept in memory only.
   */
  const update = async (host: Host, change: (s: Saved) => Saved) => {
    for (let n = 0; n < 5; n++) {
      const next = change(saved)
      try {
        const r = await host.save(next, version)
        if (r.isSet) {
          saved = next
          version = r.version
          return true
        }
        await load(host)
      } catch {
        saved = next
        return true
      }
    }
    return false
  }

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

  /** vibestd took it: any answer but none, ≥500 or another protocol (a reload to the new module sends it again). */
  const send = async (host: Host, path: string, body: unknown) => {
    try {
      const r = await post(host, path, body, REPORT_TRY_MS)
      return r.status < 500 && r.status !== 409
    } catch {
      return false
    }
  }

  /** Send each saved report again, oldest first, until one is not taken. */
  const flush = async (host: Host) => {
    if (flushing) return
    flushing = true
    try {
      for (const pending of saved.reports) {
        if (!(await send(host, pending.path, pending.body))) return
        await update(host, (s) => ({ ...s, reports: s.reports.filter((r) => r.n !== pending.n) }))
      }
    } finally {
      flushing = false
    }
  }

  /** Again after each REPORT_BACKOFF_MS pause while reports wait; a newer load's session.start flushes them too. */
  const retry = (host: Host, n: number) => {
    const pause = REPORT_BACKOFF_MS[n]
    if (pause !== undefined)
      host.after(pause, () => void flush(host).then(() => (saved.reports.length > 0 ? retry(host, n + 1) : undefined)))
  }

  /** Report `body` to `path`; one vibestd does not take is kept in `$.state` and sent again. Never throws. */
  const report = async (host: Host, path: string, body: unknown) => {
    if (await send(host, path, body)) return
    const n = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    await update(host, (s) => ({ ...s, reports: [...s.reports, { n, path, body }].slice(-REPORTS_MAX) }))
    retry(host, 0)
  }

  /** Ack what was shown and give back what was released; the ids leave the record once vibestd took them. */
  const ack = async (host: Host) => {
    const ids = saved.unacked
    const release = saved.release
    if (ids.length === 0 && release.length === 0) return
    const r = await post(host, ACK_ROUTE, { ids, release }, REPORT_TRY_MS)
    if (r.status === 200)
      await update(host, (s) => ({
        ...s,
        unacked: s.unacked.filter((id) => !ids.includes(id)),
        release: s.release.filter((id) => !release.includes(id)),
      }))
  }

  const tick = async (host: Host) => {
    if (polling) return
    polling = true
    try {
      // A newer load polls now: this one stops.
      if (!(await load(host))) {
        timer?.cancel()
        return
      }
      // `$.state` starts empty for the conversation /clear begins (the clock and this load go on): claim it again.
      if (saved.generation === "") await update(host, (s) => ({ ...s, generation }))
      if (saved.reports.length > 0) await flush(host)
      await ack(host)
      const r = await post(host, POLL_ROUTE, {}, REPORT_TRY_MS)
      if (r.status === 409) return
      if (r.status !== 200 || !isPolled(r.body)) throw new Error(errorOf(r.body) ?? `poll answered ${r.status}`)
      if (failures >= POLL_FAILURES_SHOWN) host.status(undefined)
      failures = 0
      const batch = r.body
      if (batch.ids.length === 0) return
      let queued = false
      await update(host, (s) => {
        // Taken before (still queued here, being submitted, or shown and its ack lost): acked once shown.
        const waiting = (id: number) => [...s.queue, ...s.inflight].some((b) => b.ids.includes(id))
        const again = batch.ids.filter((id) => s.seen.includes(id) && !waiting(id) && !s.unacked.includes(id))
        const fresh = batch.ids.filter((id) => !s.seen.includes(id))
        queued = fresh.length > 0 && fresh.length === batch.ids.length
        return {
          ...s,
          unacked: [...s.unacked, ...again],
          release: fresh.length > 0 && !queued ? [...s.release, ...fresh] : s.release,
          seen: queued ? [...s.seen, ...batch.ids].slice(-SEEN_MAX) : s.seen,
          queue: queued ? [...s.queue, batch] : s.queue,
        }
      })
      if (queued) host.redraw()
    } catch {
      failures += 1
      if (failures === POLL_FAILURES_SHOWN) host.status("VIBEST: vibestd does not answer; still trying")
    } finally {
      polling = false
    }
  }

  on("session.start", async ($, e, next) => {
    const host = nativeHost($)
    const who = await identity(host).catch(() => undefined)
    if (!who) return next(e)
    // A reload runs this again: the record survives it, and this load polls from now on.
    await load(host)
    await update(host, (s) => ({ ...s, generation }))
    // The harness takes input now: vibestd waits for this before it hands it a turn (rpc.ts Session.Ready).
    const pid = await host.pid().catch(() => undefined)
    void report(host, "/session/ready", pid === undefined ? {} : { pid })
    if (saved.reports.length > 0) void flush(host)
    if (timer === undefined && who.agent === "coordinator") {
      timer = host.every(POLL_MS, () => void tick(host))
      void tick(host)
    }
    return next(e)
  })

  // One batch per draw, submitted from inside this hook so this module's own prompt.submit hook sees it. Draws nothing,
  // and writes no `$.state` (refused while drawing): the prompt.submit hook moves the batch on.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const batch = saved.queue[0]
    if (batch !== undefined && !draining) {
      const host = nativeHost($)
      draining = true
      // Started here, inside the hook; its answer is handled when it comes, without holding the draw.
      host.submit(batch.line).then(
        () => {
          draining = false
          if (saved.queue.length > 0) host.redraw()
        },
        () => {
          draining = false
          host.redraw()
        },
      )
    }
    return next(e)
  })

  // Awaited, so it finishes even when a reload lands now. A failed report still returns next(e): never block or
  // continue a stopped turn. A subagent's turn (agentId set) is not the session's; the main agent's has no result (its
  // conversation id goes with every poll). `turn_id`: vibestd records a turn end once, however often it arrives.
  on("turn.complete", async ($, event, next) => {
    if (event.agentId === undefined) {
      const host = nativeHost($)
      const who = await identity(host).catch(() => undefined)
      if (who && who.agent !== "coordinator")
        await report(host, hookRoute("claude", "turn-end"), {
          hook_event_name: "TurnComplete",
          session_id: await host.conversation().catch(() => ""),
          turn_id: event.turnId,
          reason: event.reason,
          last_assistant_message: event.answer,
          ...(event.reason === "refusal" ? { refusal: event.refusal } : {}),
        })
    }
    return next(event)
  })

  // This module's own submit (a polled batch's line): its full text goes with it as context, and once it entered it is
  // acked at once. Anything else is reported; vibestd keeps only what the person submitted (origin composer or bridge),
  // and never the main agent's.
  on("prompt.submit", async ($, event, next) => {
    const host = nativeHost($)
    if (event.origin.kind === "plugin" && event.origin.name === host.plugin()) {
      const batch = saved.queue.find((b) => b.line === event.text)
      if (batch === undefined) return next(event)
      // Out of the queue before it enters, so a load that comes now does not submit it again.
      await update(host, (s) => ({
        ...s,
        queue: s.queue.filter((b) => !sameBatch(b, batch)),
        inflight: [...s.inflight, batch],
      }))
      // A one-line notice is its own full text: the prompt already holds it, so it is not sent a second time.
      const entered = await next(
        batch.text === undefined || event.text.trimEnd().endsWith(batch.text.trim())
          ? event
          : { ...event, context: [...(event.context ?? []), batch.text] },
      )
      await update(host, (s) => ({
        ...s,
        inflight: s.inflight.filter((b) => !sameBatch(b, batch)),
        ...(entered.drop === undefined
          ? { unacked: [...s.unacked, ...batch.ids] }
          : { queue: [batch, ...s.queue.filter((b) => !sameBatch(b, batch))] }),
      }))
      if (entered.drop === undefined) await ack(host).catch(() => undefined)
      return entered
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
