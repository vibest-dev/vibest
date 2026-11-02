import type { SubscriptionReport } from "@vibest/plugin"
import { type Subscription, type SubscriptionLimit } from "@vibest/schema/subscription"
// Subscriptions (architecture D10): one in-memory row per (harness, provider, machine "local"). The poll reads each
// installed harness's CLI and, for Claude and Cursor, the usage endpoint with the keychain token. A failed read keeps
// the last row. Nothing here refreshes or writes a token, and a token is never logged.
import { Clock, Config, Context, Effect, FileSystem, Layer, Option, Path, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { Harness, type HarnessId, isHarnessId } from "../harness.ts"
import { CLAUDE_CREDENTIALS, CURSOR_ACCESS_TOKEN, Keychain } from "../keychain.ts"
import { claudeAccount, claudeUsage, cursorAccount, cursorUsage, num, piAccount, record } from "./index.ts"

const MINUTE = "1 minute"
const CLI_TIMEOUT = "10 seconds"
const MACHINE = "local" as const

type Row = Subscription
/** `limits`: this poll read usage (it replaces a plugin report). `error`: usage was skipped; limits stay as they were. */
type Usage = { readonly limits: ReadonlyArray<SubscriptionLimit> } | { readonly error: string }

const keyOf = (harness: string, provider: string) => `${harness}\0${provider}`

const isLimit = (limit: SubscriptionLimit) =>
  typeof limit?.window === "string" &&
  limit.window !== "" &&
  typeof limit.percent === "number" &&
  Number.isFinite(limit.percent) &&
  (limit.status === "available" || limit.status === "limited") &&
  (limit.resetTime === null || (typeof limit.resetTime === "number" && Number.isFinite(limit.resetTime)))

/** Epoch ms. A number below 1e12 is seconds; Claude stores `expiresAt` in milliseconds. */
const epochMs = (value: number) => (value < 1e12 ? value * 1000 : value)

const claudeToken = (raw: string | undefined, now: number): { readonly token: string } | { readonly error: string } => {
  if (!raw) return { error: "token unreadable" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: "token unreadable" }
  }
  const oauth = record(record(parsed)?.claudeAiOauth)
  const token = oauth?.accessToken
  if (typeof token !== "string" || token === "") return { error: "token unreadable" }
  const exp = num(oauth?.expiresAt)
  if (exp !== undefined && epochMs(exp) <= now) return { error: "token expired" }
  return { token }
}

/** Cursor's keychain item is the access token. No expiry field: empty is unreadable, a rejected call keeps the last limits. */
const cursorToken = (raw: string | undefined): { readonly token: string } | { readonly error: string } => {
  const token = raw?.trim()
  return token ? { token } : { error: "token unreadable" }
}

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined || text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** stdin closed, 10s, stderr discarded. Undefined when it does not finish or fails to start. */
const runCli = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { stdin: "ignore", cwd }))
    const [stdout] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    )
    return stdout
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CLI_TIMEOUT),
    Effect.map((done) => (Option.isSome(done) ? done.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  )

const homeDir = Config.String("HOME").pipe(Config.withDefault(""), Effect.orDie)

/** Status and JSON body on 200; the body is dropped otherwise. Undefined when the call does not finish. Never logs the request. */
const endpoint = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(request)
    if (response.status !== 200) {
      yield* response.text.pipe(Effect.ignore)
      return { status: response.status, body: undefined as unknown }
    }
    return { status: 200, body: yield* response.json }
  }).pipe(
    Effect.timeoutOption(CLI_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  )

const authed = (request: HttpClientRequest.HttpClientRequest, token: string) =>
  HttpClientRequest.bearerToken(request, Redacted.make(token))

const keep = (prev: Row | undefined, now: number, error: string, harness: HarnessId, provider: string): Row =>
  prev
    ? { ...prev, error }
    : { harness, provider, machine: MACHINE, account: { kind: "none" }, limits: [], updatedAt: now, error }

/** No `usage` (Pi, or a poll that did not get that far) keeps whatever limits are already stored. */
const wrote = (
  prev: Row | undefined,
  now: number,
  harness: HarnessId,
  provider: string,
  account: Subscription["account"],
  usage?: Usage,
): Row => {
  const limits = usage && "limits" in usage ? usage.limits : (prev?.limits ?? [])
  const error = usage && "error" in usage ? usage.error : undefined
  return { harness, provider, machine: MACHINE, account, limits, updatedAt: now, ...(error ? { error } : {}) }
}

const readJsonFile = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).pipe(
    Effect.map(parseJson),
  )

/** Names only. auth.json values are secrets and are not kept. */
const piProviders = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* homeDir
  const dir =
    Option.getOrUndefined(yield* Config.option(Config.String("PI_CODING_AGENT_DIR")).pipe(Effect.orDie)) ||
    (home ? path.join(home, ".pi", "agent") : "")
  if (!dir) return [] as ReadonlyArray<string>
  const auth = record(yield* readJsonFile(path.join(dir, "auth.json")))
  const models = record(record(yield* readJsonFile(path.join(dir, "models.json")))?.providers)
  const fallback = record(yield* readJsonFile(path.join(dir, "settings.json")))?.defaultProvider
  const names = new Set<string>()
  if (auth)
    for (const [name, value] of Object.entries(auth)) if (value !== null && typeof value === "object") names.add(name)
  if (models) for (const name of Object.keys(models)) names.add(name)
  if (typeof fallback === "string" && fallback !== "") names.add(fallback)
  return [...names]
})

const usageOf = (
  result: Option.Option<{ readonly status: number; readonly body: unknown }>,
  limits: (body: unknown) => ReadonlyArray<SubscriptionLimit>,
): Usage =>
  Option.match(result, {
    onNone: () => ({ error: "usage endpoint failed" }),
    onSome: (r) => (r.status === 200 ? { limits: limits(r.body) } : { error: `usage endpoint answered ${r.status}` }),
  })

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly list: Effect.Effect<ReadonlyArray<Subscription>>
    /** Plugin push. Replaces limits for `(harness, provider)` until a poll actually reads usage. */
    readonly report: (input: SubscriptionReport) => Effect.Effect<void>
    /** One pass. The daemon layer repeats it; tests call it with fakes. */
    readonly poll: Effect.Effect<void, never, PollServices>
  }
>()("vibest/Subscriptions") {
  static readonly make = Effect.gen(function* () {
    const rows = yield* Ref.make(new Map<string, Row>())
    const modify = (harness: HarnessId, provider: string, f: (prev: Row | undefined, now: number) => Row) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(rows, (map) => {
          const next = new Map(map)
          next.set(keyOf(harness, provider), f(map.get(keyOf(harness, provider)), now))
          return next
        })
      })

    const list = Ref.get(rows).pipe(
      Effect.map((map) =>
        [...map.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.provider.localeCompare(b.provider)),
      ),
    )

    const report = Effect.fn("Subscriptions.report")(function* (input: SubscriptionReport) {
      const harness = input.harness
      if (!isHarnessId(harness) || !Array.isArray(input.limits) || !input.limits.every(isLimit)) {
        yield* Effect.logWarning(`subscription report ignored for ${JSON.stringify(input.harness)}`)
        return
      }
      const provider = input.provider ?? ""
      yield* modify(harness, provider, (prev, now) => ({
        harness,
        provider,
        machine: MACHINE,
        account: prev?.account ?? { kind: "none" },
        limits: input.limits,
        updatedAt: now,
      }))
    })

    const pollClaude = Effect.gen(function* () {
      const status = parseJson(yield* runCli("claude", ["auth", "status", "--json"], yield* homeDir))
      if (status === undefined)
        return yield* modify("claude", "", (prev, now) => keep(prev, now, "claude auth status failed", "claude", ""))
      const account = claudeAccount(status)
      if (account.kind !== "subscription")
        return yield* modify("claude", "", (prev, now) => wrote(prev, now, "claude", "", account, { limits: [] }))
      const read = claudeToken(
        yield* Effect.flatMap(Keychain, (k) => k.password(CLAUDE_CREDENTIALS)),
        yield* Clock.currentTimeMillis,
      )
      if ("error" in read)
        return yield* modify("claude", "", (prev, now) =>
          wrote(prev, now, "claude", "", account, { error: read.error }),
        )
      const result = yield* endpoint(
        authed(
          HttpClientRequest.setHeader(
            HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage"),
            "anthropic-beta",
            "oauth-2025-04-20",
          ),
          read.token,
        ),
      )
      yield* modify("claude", "", (prev, now) => wrote(prev, now, "claude", "", account, usageOf(result, claudeUsage)))
    })

    const pollCursor = Effect.gen(function* () {
      const cwd = yield* homeDir
      const status = parseJson(yield* runCli("cursor-agent", ["status", "--format", "json"], cwd))
      if (status === undefined)
        return yield* modify("cursor", "", (prev, now) => keep(prev, now, "cursor-agent status failed", "cursor", ""))
      const account = cursorAccount(
        status,
        parseJson(yield* runCli("cursor-agent", ["about", "--format", "json"], cwd)),
      )
      if (account.kind === "none")
        return yield* modify("cursor", "", (prev, now) => wrote(prev, now, "cursor", "", account, { limits: [] }))
      const read = cursorToken(yield* Effect.flatMap(Keychain, (k) => k.password(CURSOR_ACCESS_TOKEN)))
      if ("error" in read)
        return yield* modify("cursor", "", (prev, now) =>
          wrote(prev, now, "cursor", "", account, { error: read.error }),
        )
      const hard = yield* endpoint(
        authed(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"),
            {},
          ),
          read.token,
        ),
      )
      const hardBody = Option.match(hard, {
        onNone: () => undefined,
        onSome: (r) => (r.status === 200 ? r.body : undefined),
      })
      const usage = yield* endpoint(
        authed(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"),
            {},
          ),
          read.token,
        ),
      )
      yield* modify("cursor", "", (prev, now) =>
        wrote(
          prev,
          now,
          "cursor",
          "",
          account,
          usageOf(usage, (body) => cursorUsage(body, hardBody)),
        ),
      )
    })

    const pollPi = Effect.gen(function* () {
      const cwd = yield* homeDir
      const providers = yield* piProviders
      for (const provider of providers) {
        const check = parseJson(
          yield* runCli("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"], cwd),
        )
        if (check === undefined) {
          yield* modify("pi", provider, (prev, now) =>
            keep(prev, now, `pi auth check ${provider} failed`, "pi", provider),
          )
          continue
        }
        yield* modify("pi", provider, (prev, now) => wrote(prev, now, "pi", provider, piAccount(check)))
      }
    })

    const quiet = (id: HarnessId, effect: Effect.Effect<void, never, PollServices>) =>
      effect.pipe(Effect.catchCause(() => Effect.logWarning(`subscriptions: ${id} poll failed`)))
    // A defect is not a failed read: the row stays, and the message carries no token.
    const poll = Effect.gen(function* () {
      const harness = yield* Harness
      if (yield* harness.available("claude")) yield* quiet("claude", pollClaude)
      if (yield* harness.available("cursor")) yield* quiet("cursor", pollCursor)
      if (yield* harness.available("pi")) yield* quiet("pi", pollPi)
    })

    return Subscriptions.of({ list, report, poll })
  })

  static readonly layer = Layer.effect(Subscriptions, Subscriptions.make)

  /** The store, plus one poll as vibestd starts and then at most once a minute. Same instance the RPC reads. */
  static readonly live = Layer.effect(
    Subscriptions,
    Effect.gen(function* () {
      const service = yield* Subscriptions.make
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* service.poll
            yield* Effect.sleep(MINUTE)
          }),
        ),
      )
      return service
    }),
  )
}

type PollServices =
  | Harness
  | Keychain
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
