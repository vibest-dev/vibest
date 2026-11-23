import asyncHooks from "node:async_hooks"

import { BLOCKED_PREFIX, type Driver, type Json, type Reply, aborted } from "./driver.ts"
import { Journal } from "./journal.ts"

export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }

export interface StandardSchema<Output> {
  readonly "~standard": {
    readonly validate: (value: Json) => StandardResult<Output> | Promise<StandardResult<Output>>
  }
}

export interface AgentOptions {
  readonly title: string
  readonly prompt: string
  readonly format?: string
  readonly harness?: string
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
  readonly writes?: boolean
  readonly key?: string
}

export type SessionOptions = Omit<AgentOptions, "prompt"> & { readonly prompt?: string }

export interface Conversation {
  <T>(prompt: string, schema: StandardSchema<T>): Promise<T>
  (prompt: string): Promise<string>
  readonly session: () => string | undefined
  readonly close: () => Promise<void>
}

export interface ParallelOptions {
  readonly concurrency?: number
}

export interface ShellResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type TraceKind =
  | "phase"
  | "log"
  | "spawn"
  | "send"
  | "reply"
  | "repair"
  | "cached"
  | "reattach"
  | "interrupt"
  | "archive"
  | "shell"
  | "escalate"

export interface TraceEvent {
  readonly at: number
  readonly phase: string
  readonly kind: TraceKind
  readonly title: string
  readonly session?: string
  readonly detail?: string
}

export interface Workflow {
  readonly args: Json
  readonly phase: (name: string) => void
  readonly log: (message: string) => void
  readonly agent: {
    <T>(options: AgentOptions & { readonly schema: StandardSchema<T> }): Promise<T>
    (options: AgentOptions): Promise<string>
  }
  readonly session: (options: SessionOptions) => Conversation
  readonly parallel: <I, O>(
    items: ReadonlyArray<I>,
    run: (item: I, index: number) => Promise<O>,
    options?: ParallelOptions,
  ) => Promise<Array<O>>
  readonly pipeline: <I, A, B>(
    items: ReadonlyArray<I>,
    first: (item: I, index: number) => Promise<A>,
    then: (value: A, item: I, index: number) => Promise<B>,
    options?: ParallelOptions,
  ) => Promise<Array<B>>
  readonly shell: (command: string, options?: { readonly cwd?: string }) => Promise<ShellResult>
  readonly step: <T extends Json>(key: string, schema: StandardSchema<T>, run: () => Promise<T>) => Promise<T>
}

export type WorkflowScript = (wf: Workflow) => Promise<Json>

export class Escalation extends Error {
  constructor(
    readonly kind: "blocked" | "limit",
    readonly session: string,
    readonly title: string,
    readonly detail: string,
  ) {
    super(`${title} (${session}) is ${kind}: ${detail}`)
  }
}

export class AgentFailed extends Error {
  constructor(
    readonly session: string,
    readonly title: string,
    readonly failure: string,
  ) {
    super(`${title} (${session}) failed: ${failure}`)
  }
}

export class OutputInvalid extends Error {
  constructor(
    readonly session: string,
    readonly title: string,
    readonly problem: string,
  ) {
    super(`${title} (${session}) gave no valid output after a repair turn: ${problem}`)
  }
}

export class Cancelled extends Error {}

export type SessionState = "archived" | "kept" | "open"

export interface RunReport {
  readonly status: "completed" | "escalated" | "failed" | "cancelled"
  readonly result?: Json
  readonly error?: string
  readonly escalation?: {
    readonly kind: string
    readonly session: string
    readonly title: string
    readonly detail: string
  }
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly title: string; readonly state: SessionState }>
  readonly trace: ReadonlyArray<TraceEvent>
}

export interface RunOptions {
  readonly driver: Driver
  readonly journal?: Journal
  readonly args?: Json
  readonly signal?: AbortSignal
  readonly onTrace?: (event: TraceEvent) => void
}

export const WORKER_RULES = [
  "You are one step of a vibest workflow. A program, not a person, reads your final reply with vibest result.",
  "Do not send your report with vibest send: your final reply is the report.",
  `If you cannot go on without a person's decision, start your final reply with ${BLOCKED_PREFIX} followed by the question.`,
].join("\n")

const outputRule = (format: string | undefined) =>
  `End your final reply with exactly one fenced \`\`\`json block holding the result${format === undefined ? "." : `: ${format}`}`

const FENCED_JSON = /```json\s*\n([\s\S]*?)\n?```/g

const issueText = (issue: StandardIssue) => {
  const path = (issue.path ?? []).map((part) => String(part instanceof Object ? part.key : part)).join(".")

  return path === "" ? issue.message : `${path}: ${issue.message}`
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string }

const parsedJson = (raw: string): Checked<Json> => {
  try {
    const value: Json = JSON.parse(raw)

    return { ok: true, value }
  } catch (error) {
    return { ok: false, problem: `the json block does not parse: ${String(error)}` }
  }
}

export const checkOutput = async <T>(schema: StandardSchema<T>, text: string): Promise<Checked<T>> => {
  const raw = [...text.matchAll(FENCED_JSON)].at(-1)?.[1] ?? text.trim()
  const parsed = parsedJson(raw)

  if (!parsed.ok) return parsed
  const result = await schema["~standard"].validate(parsed.value)

  return result.issues === undefined
    ? { ok: true, value: result.value }
    : { ok: false, problem: result.issues.map(issueText).join("; ") }
}

interface Track {
  readonly title: string
  readonly options: SessionOptions
  readonly base: string
  id: string | undefined
  last: number
  turns: number
  queue: Promise<void>
  state: SessionState
}

interface Scope {
  readonly signal: AbortSignal
}

export const runWorkflow = async (script: WorkflowScript, options: RunOptions): Promise<RunReport> => {
  const { driver } = options
  const journal = options.journal ?? (await Journal.open())
  const root = new AbortController()
  const scope = new asyncHooks.AsyncLocalStorage<Scope>()
  const trace: Array<TraceEvent> = []
  const tracks: Array<Track> = []
  const seenKeys = new Map<string, number>()
  let phaseName = "main"

  if (options.signal !== undefined) {
    const outer = options.signal

    if (outer.aborted) root.abort(outer.reason)
    else outer.addEventListener("abort", () => root.abort(outer.reason), { once: true })
  }

  const currentSignal = () => scope.getStore()?.signal ?? root.signal

  const record = (kind: TraceKind, title: string, session?: string, detail?: string) => {
    const event: TraceEvent = {
      at: Date.now(),
      phase: phaseName,
      kind,
      title,
      ...(session !== undefined && { session }),
      ...(detail !== undefined && { detail }),
    }

    trace.push(event)
    options.onTrace?.(event)
  }

  const uniqueKey = (base: string) => {
    const count = (seenKeys.get(base) ?? 0) + 1
    seenKeys.set(base, count)

    return count === 1 ? base : `${base}#${count}`
  }

  const cancelledBy = (signal: AbortSignal) =>
    signal.reason instanceof Error && !(signal.reason instanceof Cancelled)
      ? new Cancelled(`cancelled after a sibling failed: ${signal.reason.message}`)
      : new Cancelled("cancelled")

  const awaitReply = async (track: Track, session: string, after: number) => {
    const signal = currentSignal()

    try {
      return await Promise.race([driver.reply(session, after, signal), aborted(signal)])
    } catch (error) {
      if (!signal.aborted) throw error
      record("interrupt", track.title, session)
      await driver.interrupt(session)
      throw cancelledBy(signal)
    }
  }

  const deliver = async (track: Track, message: string) => {
    currentSignal().throwIfAborted()
    const first = track.id === undefined
    const prompt = first ? [WORKER_RULES, track.options.prompt, message].filter(Boolean).join("\n\n") : message

    if (track.id === undefined) {
      track.id = await driver.spawn({
        title: track.title,
        prompt,
        harness: track.options.harness,
        agent: track.options.agent,
        provider: track.options.provider,
        model: track.options.model,
      })
      record("spawn", track.title, track.id, track.options.harness)
    } else {
      await driver.send(track.id, prompt)
      record("send", track.title, track.id)
    }

    return { session: track.id, after: track.last }
  }

  const settle = async (track: Track, key: string, session: string, reply: Reply) => {
    track.last = reply.execution

    if (reply.outcome === "completed") return reply.text
    const detail = reply.failure ?? reply.text
    await journal.set(key, { session, after: reply.execution, sent: reply.outcome === "blocked" })
    record(reply.outcome === "failed" ? "reply" : "escalate", track.title, session, `${reply.outcome}: ${detail}`)

    if (reply.outcome === "blocked" || reply.outcome === "limit")
      throw new Escalation(reply.outcome, session, track.title, detail)

    if (reply.outcome === "interrupted") throw new Cancelled(`${track.title} was interrupted`)

    throw new AgentFailed(session, track.title, detail)
  }

  const exchange = async (track: Track, key: string, message: string) => {
    const saved = journal.get(key)

    if (saved?.session !== undefined) {
      track.id ??= saved.session
      track.last = Math.max(track.last, saved.after ?? 0)
    }

    if (saved?.session !== undefined && saved.sent === true) {
      record("reattach", track.title, saved.session)

      return settle(track, key, saved.session, await awaitReply(track, saved.session, saved.after ?? 0))
    }

    const sent = await deliver(track, message)
    await journal.set(key, { ...sent, sent: true })

    return settle(track, key, sent.session, await awaitReply(track, sent.session, sent.after))
  }

  async function turn(track: Track, message: string): Promise<string>
  async function turn<T>(track: Track, message: string, schema: StandardSchema<T>): Promise<T>
  async function turn<T>(track: Track, message: string, schema?: StandardSchema<T>): Promise<T | string> {
    track.turns += 1
    const key = `${track.base}/${track.turns}`
    const saved = journal.get(key)
    const ask = schema === undefined ? message : `${message}\n\n${outputRule(track.options.format)}`

    if (saved?.text !== undefined) {
      track.id = saved.session
      track.last = saved.after ?? track.last
      record("cached", track.title, saved.session, key)
    }

    let text = saved?.text ?? (await exchange(track, key, ask))

    if (schema === undefined) {
      await journal.set(key, { ...journal.get(key), text })

      return text
    }

    let checked = await checkOutput(schema, text)

    if (!checked.ok) {
      const session = track.id ?? ""
      record("repair", track.title, session, checked.problem)
      text = await exchange(
        track,
        `${key}/repair`,
        `Your last reply has no valid result: ${checked.problem}. Reply again with the corrected result. ${outputRule(track.options.format)}`,
      )
      checked = await checkOutput(schema, text)

      if (!checked.ok) throw new OutputInvalid(session, track.title, checked.problem)
    }

    await journal.set(key, { ...journal.get(key), text })
    record("reply", track.title, track.id, "valid")

    return checked.value
  }

  const archive = async (track: Track) => {
    if (track.id === undefined || track.state !== "open") return

    if (track.options.writes === true) {
      track.state = "kept"

      return
    }

    const key = `${track.base}/archived`

    if (journal.get(key) === undefined) {
      await driver.archive(track.id)
      await journal.set(key, { session: track.id })
      record("archive", track.title, track.id)
    }

    track.state = "archived"
  }

  const open = (options: SessionOptions): Track => {
    const track: Track = {
      title: options.title,
      options,
      base: uniqueKey(options.key ?? `${phaseName}/${options.title}`),
      id: undefined,
      last: 0,
      turns: 0,
      queue: Promise.resolve(),
      state: "open",
    }

    tracks.push(track)

    return track
  }

  function agent<T>(options: AgentOptions & { readonly schema: StandardSchema<T> }): Promise<T>
  function agent(options: AgentOptions): Promise<string>
  async function agent<T>(options: AgentOptions & { readonly schema?: StandardSchema<T> }): Promise<T | string> {
    const track = open({ ...options, prompt: "" })

    const value =
      options.schema === undefined
        ? await turn(track, options.prompt)
        : await turn(track, options.prompt, options.schema)

    await archive(track)

    return value
  }

  const session = (options: SessionOptions): Conversation => {
    const track = open(options)

    function ask(prompt: string): Promise<string>
    function ask<T>(prompt: string, schema: StandardSchema<T>): Promise<T>
    function ask<T>(prompt: string, schema?: StandardSchema<T>): Promise<T | string> {
      const next = track.queue.then((): Promise<T | string> =>
        schema === undefined ? turn(track, prompt) : turn(track, prompt, schema),
      )

      track.queue = next.then(
        () => undefined,
        () => undefined,
      )

      return next
    }

    return Object.assign(ask, { session: () => track.id, close: () => track.queue.then(() => archive(track)) })
  }

  const parallel = async <I, O>(
    items: ReadonlyArray<I>,
    run: (item: I, index: number) => Promise<O>,
    parallelOptions?: ParallelOptions,
  ) => {
    const parent = currentSignal()
    const lanes = new AbortController()
    const stop = () => lanes.abort(parent.reason)
    parent.addEventListener("abort", stop, { once: true })
    const results: Array<O> = []
    const failures: Array<Error> = []
    let next = 0

    const lane = async () => {
      while (next < items.length && !lanes.signal.aborted) {
        const index = next
        next += 1

        try {
          results[index] = await scope.run({ signal: lanes.signal }, () => run(items[index]!, index))
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          failures.push(failure)
          lanes.abort(failure)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(parallelOptions?.concurrency ?? items.length, items.length) }, lane),
    )
    parent.removeEventListener("abort", stop)
    const first = failures.find((failure) => !(failure instanceof Cancelled)) ?? failures[0]

    if (first !== undefined) throw first

    return results
  }

  const shell = async (command: string, shellOptions?: { readonly cwd?: string }) => {
    const signal = currentSignal()
    signal.throwIfAborted()

    const child = Bun.spawn(["sh", "-c", command], {
      ...(shellOptions?.cwd !== undefined && { cwd: shellOptions.cwd }),
      stdout: "pipe",
      stderr: "pipe",
    })

    const kill = () => child.kill()
    signal.addEventListener("abort", kill, { once: true })

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    signal.removeEventListener("abort", kill)
    record("shell", command, undefined, `exit ${code}`)

    if (signal.aborted) throw cancelledBy(signal)

    return { code, stdout, stderr }
  }

  const step = async <T extends Json>(key: string, schema: StandardSchema<T>, run: () => Promise<T>) => {
    const saved = journal.get(`step/${key}`)

    if (saved?.value !== undefined) {
      const checked = await schema["~standard"].validate(saved.value)

      if (checked.issues === undefined) {
        record("cached", key, undefined, `step/${key}`)

        return checked.value
      }
    }

    const value = await run()
    await journal.set(`step/${key}`, { value })

    return value
  }

  const wf: Workflow = {
    args: options.args ?? null,
    phase: (name) => {
      phaseName = name
      record("phase", name)
    },
    log: (message) => record("log", message),
    agent,
    session,
    parallel,
    pipeline: (items, first, then, pipelineOptions) =>
      parallel(items, async (item, index) => then(await first(item, index), item, index), pipelineOptions),
    shell,
    step,
  }

  const sessions = () =>
    tracks.flatMap((track) =>
      track.id === undefined ? [] : [{ id: track.id, title: track.title, state: track.state }],
    )

  try {
    const result = await scope.run({ signal: root.signal }, () => script(wf))
    await Promise.all(tracks.map((track) => track.queue.then(() => archive(track))))

    return { status: "completed", result, sessions: sessions(), trace }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (error instanceof Escalation)
      return {
        status: "escalated",
        error: message,
        escalation: { kind: error.kind, session: error.session, title: error.title, detail: error.detail },
        sessions: sessions(),
        trace,
      }

    return { status: error instanceof Cancelled ? "cancelled" : "failed", error: message, sessions: sessions(), trace }
  }
}
