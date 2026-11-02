/**
 * The Claude Code hooks module of the VIBEST coordinator inbox, bundled to hooks/register.mjs by scripts/build.ts.
 * It binds the accepted client (inbox-client.ts) and adapters (inbox-adapter.ts) to the native host:
 * `vibest inbox …` through `$.process.run` (bare argv, PATH and inherited environment), the claim body through `$.fs.read`,
 * delivery through `$.prompt.submit`.
 *
 * Turn-end reports, the user prompt, and the tool guard are native `classic.Stop`, `classic.StopFailure`,
 * `classic.UserPromptSubmit` and `classic.PreToolUse` listeners, not command hooks. They call fixed argv
 * `vibest integration stop --harness claude`, `vibest integration prompt --harness claude` and
 * `vibest integration guard --harness claude`. No shell, no VIBEST_COMMAND.
 *
 * The inbox listeners (session.start, session.end, command.run) are always registered. Only a coordinator
 * (VIBEST_AGENT=coordinator with an VIBEST_SESSION_ID) activates a receiver; anywhere else the module registers no
 * /vibest-reattach command, starts no timer and never calls `vibest inbox`.
 * Startup attaches without replace, and keeps trying ordinary attach while VIBEST answers not-reported;
 * `/vibest-reattach` is the only replace. No shared store, takeover after reload,
 * detach, lease, or pane-move recovery. No session.start report.
 *
 * Types: `import type` from `claude-code`. The declarations are a local ignored cache, not a vendored file.
 * Pin: anthropics/claude-code 2eff7a8d21c80be48904f62ebdea36d945d7b504 (mods/types/claude-code.d.ts).
 * That file's "Written by Claude Code 2.1.277" header is stale and does not date this pin.
 * Hooks modules are early access and may change without notice. This revision has not been loaded in Claude.
 */
import type { EngineInterface, On, ProcessRunResult, Register } from "claude-code"

import { adaptAttach, adaptPull, adaptSettle } from "./inbox-adapter.ts"
import { createClaudeInboxClient, type SubmitReply } from "./inbox-client.ts"

type RunResult = ProcessRunResult

export const REATTACH = "vibest-reattach"
/** Ticks never overlap; each `vibest` call is killed after RUN_TIMEOUT_MS. */
export const POLL_MS = 2000
export const RUN_TIMEOUT_MS = 15_000
/** Bound for `vibest integration stop` and `vibest integration guard`. */
export const BRIDGE_TIMEOUT_MS = 10_000
/** The managed hook's refusal when vibest cannot answer a PreToolUse check. */
export const GUARD_FAILURE = "vibest integration guard failed; the tool call is refused."

/** The `error` a refusing `vibest inbox attach` printed, for the status line only (the adapter decides the reply). */
const errorOf = (stdout: string) => {
  try {
    const value = JSON.parse(stdout) as { error?: unknown }
    return typeof value?.error === "string" ? value.error : undefined
  } catch {
    return undefined
  }
}

const refusal = (why: string) => {
  if (why === "stale-receiver") return `another receiver holds this coordinator's inbox; run /${REATTACH} to take it`
  if (why === "not-reported") return `VIBEST has not recorded this Claude session yet; run /${REATTACH} once it has`
  if (why === "session-mismatch") return `the Claude session changed, so delivery stopped; run /${REATTACH}`
  if (why.startsWith("exit "))
    return `vibest inbox attach failed (${why}); check that vibest on PATH has the inbox command`
  return `vibest inbox attach refused (${why}); run /${REATTACH} after fixing it`
}

/** A replace whose reply was lost may have committed: this receiver may already be retired. It is never replayed. */
const unknownReplace = (why: string) =>
  `vibest inbox attach --replace gave no usable answer (${why}). It may have replaced this receiver anyway, so it is not retried automatically and delivery here may stop. Run /${REATTACH} again.`

/**
 * Every native call this module makes, bound to one hook's `$`. Claude Code statically checks a hooks module: `$` may
 * be passed only to a top-level function declaration of the same file, so the helpers inside `register` get these
 * callbacks, never `$` itself.
 */
function nativeHost($: EngineInterface) {
  return {
    coordinator: async () =>
      (await $.env.get("VIBEST_AGENT")) === "coordinator" && ((await $.env.get("VIBEST_SESSION_ID")) ?? "") !== "",
    agent: () => $.env.get("VIBEST_AGENT"),
    vibestSession: () => $.env.get("VIBEST_SESSION_ID"),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    run: (argv: ReadonlyArray<string>) => $.process.run(["vibest", "inbox", ...argv], { timeoutMs: RUN_TIMEOUT_MS }),
    stop: (stdin: string) =>
      $.process.run(["vibest", "integration", "stop", "--harness", "claude"], { stdin, timeoutMs: BRIDGE_TIMEOUT_MS }),
    prompt: (stdin: string) =>
      $.process.run(["vibest", "integration", "prompt", "--harness", "claude"], {
        stdin,
        timeoutMs: BRIDGE_TIMEOUT_MS,
      }),
    guard: (stdin: string) =>
      $.process.run(["vibest", "integration", "guard", "--harness", "claude"], { stdin, timeoutMs: BRIDGE_TIMEOUT_MS }),
    read: (file: string) => $.fs.read(file),
    submit: (text: string) => $.prompt.submit({ text }),
    registerReattach: () =>
      $.command.register({
        name: REATTACH,
        description: "Take this coordinator's VIBEST inbox with a new generation (attach --replace)",
        immediate: true,
      }),
    every: (fn: () => void) => $.clock.every(POLL_MS, fn),
    status: (text: string) => $.ui.status(`VIBEST inbox: ${text}`),
    /** Claude Code draws every pinned plugin status as a warning, so a healthy inbox clears its line and says so once. */
    attached: () => {
      $.ui.status(undefined)
      $.ui.toast("VIBEST inbox attached")
    },
  }
}

type Host = ReturnType<typeof nativeHost>

/** Tool arguments on a classic.PreToolUse envelope: every field except the envelope's own `tool` and `tool_use_id`. */
const toolInput = (event: object): Record<string, unknown> => {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (key !== "tool" && key !== "tool_use_id") input[key] = value
  }
  return input
}

/** A deny reason from guard stdout, only for the object Guard.hook prints. Undefined when the body is not that object. */
const guardDenyReason = (stdout: string): string | undefined => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "hookSpecificOutput") return undefined
  const output = (value as { readonly hookSpecificOutput: unknown }).hookSpecificOutput
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined
  const fields = Object.keys(output)
  if (
    fields.length !== 3 ||
    !fields.includes("hookEventName") ||
    !fields.includes("permissionDecision") ||
    !fields.includes("permissionDecisionReason")
  )
    return undefined
  const denial = output as {
    readonly hookEventName: unknown
    readonly permissionDecision: unknown
    readonly permissionDecisionReason: unknown
  }
  if (
    denial.hookEventName !== "PreToolUse" ||
    denial.permissionDecision !== "deny" ||
    typeof denial.permissionDecisionReason !== "string"
  )
    return undefined
  return denial.permissionDecisionReason
}

/** Undefined lets the call through. Any other answer, including a failed bridge, denies. */
const guardReason = (result: RunResult): string | undefined => {
  if (result.exitCode === 0 && result.stdout.trim() === "") return undefined
  if (result.exitCode !== 0) return GUARD_FAILURE
  return guardDenyReason(result.stdout) ?? GUARD_FAILURE
}

// A top-level function declaration: Claude Code's loader accepts `register` in no other shape.
export function register(on: On, _options?: unknown) {
  let started = false
  let client: ReturnType<typeof createClaudeInboxClient> | undefined
  let lastRefusal = "unparsed"
  let timer: { cancel: () => void } | undefined
  // Session lifetime: session.end bumps `lifetime` and sets `ended`; only a reattach confirmed in the same lifetime clears it.
  let lifetime = 0
  let ended = false
  let current = ""
  // Host ownership of a step: a reattach bumps `epoch`, so a step left waiting on the old generation neither blocks
  // the new one nor clears its busy mark. The client fences its own callbacks the same way.
  let epoch = 0
  let busy: number | undefined
  let reattaching = false

  /** The session id, or undefined when a session.end landed while it was read (that read belongs to the old lifetime). */
  const readSession = async (host: Host) => {
    const seen = lifetime
    const id = await host.sessionId()
    return seen === lifetime ? id : undefined
  }

  const attachArgv = (sessionId: string, replace: boolean) =>
    replace ? ["attach", sessionId, "--replace"] : ["attach", sessionId]

  const makeClient = (host: Host) =>
    createClaudeInboxClient({
      sessionId: () => (ended ? "" : current),
      attach: async (sessionId) => {
        lastRefusal = "no reply"
        const r = await host.run(attachArgv(sessionId, false))
        lastRefusal = r.exitCode !== 0 ? `exit ${r.exitCode}` : (errorOf(r.stdout) ?? "unparsed")
        return adaptAttach(r.exitCode, r.stdout)
      },
      pull: async (generation, sessionId) => {
        const r = await host.run(["pull", generation, sessionId])
        return adaptPull(r.exitCode, r.stdout)
      },
      readClaim: async (file) => {
        const body = await host.read(file)
        if (typeof body !== "string") throw new Error("claim body is not text")
        return body
      },
      submit: async (text): Promise<SubmitReply> => {
        // Accepted or queued is delivery acceptance, not a finished VIBEST task. A throw is ambiguous (the client says so).
        const r = await host.submit(text)
        return r.drop !== undefined ? { kind: "drop" } : { kind: "accepted", text: r.text }
      },
      ack: async (generation, sessionId, token) => {
        const r = await host.run(["ack", generation, sessionId, token])
        return adaptSettle(r.exitCode, r.stdout, "ack")
      },
      release: async (generation, sessionId, token, retry) => {
        const r = await host.run(["release", generation, sessionId, token, ...(retry ? ["--retry"] : [])])
        return adaptSettle(r.exitCode, r.stdout, "release")
      },
    })

  const halt = () => {
    timer?.cancel()
    timer = undefined
  }

  const step = async (host: Host) => {
    if (!client || ended || busy === epoch) return
    const mine = epoch
    busy = mine
    try {
      const id = await readSession(host)
      if (id === undefined || ended || mine !== epoch) return
      current = id
      const before = client.snapshot().phase
      const snap = before === "new" ? await client.start() : await client.tick()
      if (mine !== epoch || ended) return
      if (before === "new" && snap.phase === "idle") host.attached()
      // not-reported: VIBEST records the session when a turn ends (Stop / StopFailure); the next poll attaches again.
      if (before === "new" && snap.phase === "new")
        host.status("waiting for VIBEST to record this Claude session (after a turn ends)")
      if (snap.phase === "stopped") {
        halt()
        host.status(refusal(snap.stopReason === "attach-failed" ? lastRefusal : (snap.stopReason ?? "unparsed")))
      }
    } catch {
      // A failed session read leaves the state as it was; the next tick tries again.
    } finally {
      if (busy === mine) busy = undefined
    }
  }

  const poll = (host: Host) => {
    timer ??= host.every(() => void step(host))
  }

  on("session.start", async ($, e, next) => {
    const host = nativeHost($)
    if (!started && (await host.coordinator())) {
      started = true
      client = makeClient(host)
      await host.registerReattach()
      poll(host)
    }
    return next(e)
  })

  on("session.end", async ($, e, next) => {
    lifetime += 1
    ended = true
    if (client) {
      halt()
      nativeHost($).status(refusal("session-mismatch"))
    }
    return next(e)
  })

  on("command.run", { command: REATTACH }, async ($) => {
    if (!client) return { text: "Not an VIBEST coordinator session: nothing to reattach." }
    if (reattaching) return { text: `A /${REATTACH} is already running; wait for its answer.` }
    reattaching = true
    const host = nativeHost($)
    try {
      const seen = lifetime
      const sessionId = await readSession(host).catch(() => undefined)
      if (sessionId === undefined)
        return { text: `Could not read this Claude session; nothing was sent. Run /${REATTACH} again.` }
      let r: RunResult
      try {
        r = await host.run(attachArgv(sessionId, true))
      } catch {
        return { text: unknownReplace("no reply") }
      }
      const reply = adaptAttach(r.exitCode, r.stdout)
      if (reply.kind !== "attached") {
        // Only a refusal the server printed is known not to have replaced anything.
        const refused = r.exitCode === 0 ? errorOf(r.stdout) : undefined
        if (refused !== undefined) return { text: `VIBEST inbox not reattached (${refused}); the inbox is unchanged.` }
        return { text: unknownReplace(r.exitCode !== 0 ? `exit ${r.exitCode}` : "unparsed reply") }
      }
      if (seen !== lifetime)
        return {
          text: `The Claude session changed while reattaching; generation not used here. Run /${REATTACH} again.`,
        }
      current = sessionId
      ended = false
      epoch += 1
      busy = undefined
      client.reattach(reply.generation)
      host.attached()
      poll(host)
      return { text: "VIBEST inbox reattached with a new generation." }
    } finally {
      reattaching = false
    }
  })

  // Side effect only. A bridge failure still returns next(e): never block or continue a stopped turn.
  const reportStop = async <E, R>(host: Host, event: E, next: (event: E) => Promise<R>): Promise<R> => {
    try {
      const agent = await host.agent()
      const session = await host.vibestSession()
      if (agent && session) await host.stop(JSON.stringify(event))
    } catch {
      // A missed report is not a blocked turn. vibestd scans a result file the bridge already wrote.
    }
    return next(event)
  }

  on("classic.Stop", ($, event, next) => reportStop(nativeHost($), event, next))
  on("classic.StopFailure", ($, event, next) => reportStop(nativeHost($), event, next))

  // Side effect only. A bridge failure still returns next(e): never block the user's prompt. The coordinator's pane is the
  // normal conversation; a nested agent and a non-user source are not the person typing.
  on("classic.UserPromptSubmit", async ($, event, next) => {
    try {
      if (!event.agent_id && (event.source === undefined || event.source === "user")) {
        const host = nativeHost($)
        const agent = await host.agent()
        const session = await host.vibestSession()
        if (agent && session && agent !== "coordinator") await host.prompt(JSON.stringify(event))
      }
    } catch {
      // A missed report is not a blocked prompt. The turn still runs.
    }
    return next(event)
  })

  on("classic.PreToolUse", async ($, event, next) => {
    const host = nativeHost($)
    if (!(await host.agent())) return next(event)
    try {
      const reason = guardReason(
        await host.guard(
          JSON.stringify({ tool_name: event.tool, tool_input: toolInput(event), cwd: await host.cwd() }),
        ),
      )
      return reason === undefined ? next(event) : { deny: reason }
    } catch {
      return { deny: GUARD_FAILURE }
    }
  }).catch(async ($, event, next) => {
    // A failed hook is skipped unless this handler answers. Outside VIBEST that skip must stay a pass.
    try {
      if (!(await nativeHost($).agent())) return undefined
    } catch {
      return undefined
    }
    if (next.called) return next(event)
    return { deny: GUARD_FAILURE }
  })
}

type _Assert<T extends true> = T
type _MatchesRegister = _Assert<typeof register extends Register ? true : false>
