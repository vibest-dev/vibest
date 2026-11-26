import crypto from "node:crypto"

import { assert, describe, it } from "@effect/vitest"
import {
  Automation,
  AutomationEventStream,
  AutomationSecretStore,
  AutomationStore,
  followingSlot,
  nextCron,
  parseTime,
} from "@vibest/core/automation"
import { Bus, equalToReplay } from "@vibest/core/bus"
import { CodeMode } from "@vibest/core/codemode"
import { Database } from "@vibest/core/database/database"
import { checkLedger, open } from "@vibest/core/database/migration"
import {
  AUTOMATION_MIGRATION_ID,
  BASELINE_PROJECTION_SCHEMA,
  inspectSchema,
  LOG_SCHEMA,
} from "@vibest/core/database/schema.sql"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Mcp } from "@vibest/core/mcp"
import { ProjectStore } from "@vibest/core/project/store"
import { Projectors } from "@vibest/core/reactor"
import { Session } from "@vibest/core/session"
import { Automation as AutomationSchema } from "@vibest/schema/automation"
import type { CodeMode as CodeModeSchema } from "@vibest/schema/codemode"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { Mcp as McpSchema } from "@vibest/schema/mcp"
import { ProjectEvent } from "@vibest/schema/project-event"
import { NoSuchSession } from "@vibest/schema/session"
import { memorySqlite, services as bunServices } from "@vibest/testkit/bun"
import { tempDirectory } from "@vibest/testkit/fakes"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Cron, DateTime, Duration, Effect, Exit, Layer, Option, Queue, Result, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

const sha256Hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex")

const SESSION_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"

interface FakeSentMessage {
  readonly id: string
  readonly message: string
  readonly request?: string | undefined
}

interface FakeSpawnCall {
  readonly agent: string
  readonly prompt: string
  readonly request?: string | undefined
}

interface HarnessOptions {
  readonly executeCode?: (
    request: CodeModeSchema.ExecuteRequest,
    options?: CodeMode.ExecuteOptions,
  ) => Effect.Effect<CodeModeSchema.ExecutionResult>
  readonly eventTypes?: ReadonlyArray<McpSchema.EventType>
  readonly eventQueue?: Queue.Queue<McpSchema.EventMessage>
  readonly failSend?: boolean
}

const makeHarness = (options: HarnessOptions = {}) => {
  const sent: Array<FakeSentMessage> = []
  const spawned: Array<FakeSpawnCall> = []
  const streamCursors: Array<string | null | undefined> = []

  const fakeMcp: Mcp.Interface = {
    awaitStartup: () => Effect.void,
    list: () => Effect.succeed([]),
    add: (server) => Effect.fail(new McpSchema.ConfigError({ message: `not implemented: ${server}` })),
    remove: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: `not found: ${server}` })),
    connect: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: `not found: ${server}` })),
    disconnect: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: `not found: ${server}` })),
    tools: () => Effect.succeed([]),
    search: () => Effect.succeed([]),
    describe: (server, tool) =>
      Effect.fail(new McpSchema.ToolNotFoundError({ server, tool, message: `not found: ${server}.${tool}` })),
    call: ({ server, tool }) =>
      Effect.fail(new McpSchema.ToolCallError({ server, tool, message: `not implemented: ${server}.${tool}` })),
    events: () => Effect.succeed(options.eventTypes ?? []),
    eventStream: (input) =>
      Stream.suspend(() => {
        streamCursors.push(input.cursor)

        if (!options.eventQueue) {
          return Stream.fail(
            new McpSchema.ToolCallError({ server: input.server, tool: "events/stream", message: "no event queue" }),
          )
        }

        return Stream.fromQueue(options.eventQueue)
      }),
    skills: () => Effect.succeed([]),
    read: ({ server, uri }) =>
      Effect.fail(new McpSchema.ToolCallError({ server, tool: "resources/read", message: `not implemented: ${uri}` })),
    authStart: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: server })),
    authComplete: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: server })),
    authSetToken: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: server })),
    authLogout: (server) => Effect.fail(new McpSchema.NotFoundError({ server, message: server })),
  }

  const fakeCodeMode: CodeMode.Interface = {
    execute: (request, executeOptions) =>
      options.executeCode
        ? options.executeCode(request, executeOptions)
        : Effect.succeed({
            ok: true,
            value: null,
            logs: [],
            calls: [],
            storeWrites: { set: {}, delete: [] },
          }),
    checkSyntax: () => Result.succeed(undefined),
    declarations: () => Effect.succeed({ declarations: "", servers: [], toolCount: 0 }),
  }

  const fakeSession: Session.Interface = {
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push({ agent: input.agent, prompt: input.prompt, request: input.request })

        return {
          id: `child-${spawned.length}`,
          harness: "claude",
          provider: undefined,
          model: undefined,
          runtime: "herdr",
          decidedBy: {},
          trace: [],
          worktree: input.root,
        }
      }),
    send: (id, message, _sender, request) =>
      options.failSend
        ? Effect.fail(new NoSuchSession({ id, message: `missing session ${id}` }))
        : Effect.sync(() => {
            sent.push({ id, message, request })
          }),
    admit: () => Effect.fail(new NoSuchSession({ id: "", message: "not implemented" })),
    interrupt: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    archive: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    stop: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    get: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    peek: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    seen: (id) => Effect.fail(new NoSuchSession({ id, message: "not implemented" })),
    list: () => Effect.succeed([]),
    check: () => Effect.void,
    userPrompt: () => Effect.void,
    typeTaken: () => Effect.void,
    republish: Effect.succeed(0),
    inMemory: Effect.succeed({ tracked: 0, locks: 0, reconciles: 0 }),
    outdated: Effect.succeed([]),
    restart: () => Effect.succeed([]),
    restartLater: () => Effect.void,
  }

  const tempLayout = Layer.effect(Layout, tempDirectory("vibest-auto-home-").pipe(Effect.flatMap(Layout.make))).pipe(
    Layer.provide(bunServices),
  )

  const layer = LayerNode.compile(
    LayerNode.group([
      Automation.node,
      AutomationStore.node,
      AutomationSecretStore.node,
      Bus.node,
      Database.node,
      ProjectStore.node,
    ]),
    {
      replacements: [
        PlatformNode.sqlClientLayer.replace(Layer.succeed(PlatformNode.SqlClientLayer, Layer.fresh(memorySqlite))),
        Mcp.node.replace(Layer.succeed(Mcp.Service, fakeMcp)),
        CodeMode.node.replace(Layer.succeed(CodeMode.Service, fakeCodeMode)),
        Session.node.replace(Layer.succeed(Session.Service, fakeSession)),
        PlatformNode.digest.replace(bunServices),
        PlatformNode.path.replace(bunServices),
        PlatformNode.fileSystem.replace(bunServices),
        PlatformNode.layout.replace(tempLayout),
      ],
    },
  )

  return { layer, sent, spawned, streamCursors }
}

describe("Automation core", () => {
  it("parses relative, ISO offset, and zoned wall-clock times, coalesces missed every slots, and guards DST fallback", () => {
    const utc = DateTime.zoneMakeNamedUnsafe("UTC")
    const base = Date.parse("2026-11-01T00:00:00Z")

    const rel = parseTime("in 10 minutes", utc, base)
    assert.isTrue(Option.isSome(rel))

    if (Option.isSome(rel)) assert.strictEqual(rel.value, base + 10 * 60_000)

    const iso = parseTime("2026-11-01T05:30:00Z", utc, base)
    assert.isTrue(Option.isSome(iso))

    if (Option.isSome(iso)) assert.strictEqual(iso.value, Date.parse("2026-11-01T05:30:00Z"))

    const ny = DateTime.zoneMakeNamedUnsafe("America/New_York")
    const zoned = parseTime("2026-11-02T09:00", ny, base)
    assert.isTrue(Option.isSome(zoned))

    if (Option.isSome(zoned)) assert.strictEqual(zoned.value, Date.parse("2026-11-02T14:00:00Z"))

    const coalesced = followingSlot({ type: "every", every: "5 minutes" }, "UTC", base, base + 27 * 60_000)
    assert.strictEqual(coalesced, base + 30 * 60_000)

    const dstCron = Cron.parseUnsafe("30 1 * * *", "America/New_York")
    const duringFallback = Date.parse("2026-11-01T05:30:00Z")
    const afterDst = nextCron(dstCron, duringFallback)
    assert.isDefined(afterDst)
    assert.isAbove(afterDst!, duringFallback)
  })

  it.effect("runs 0-token CodeMode gate for 2 quiet ticks then delivers on tick 3 and transitions to done", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        executeCode: (request) => {
          const input = request.bindings?.input as { readonly state: { seen?: number } | null; readonly runs: number }
          const seen = (input.state?.seen ?? 0) + 1

          if (seen < 3) {
            return Effect.succeed({
              ok: true,
              value: { state: { seen } },
              logs: [`quiet check ${seen}`],
              calls: [],
              storeWrites: { set: {}, delete: [] },
            })
          }

          return Effect.succeed({
            ok: true,
            value: { state: { seen }, done: true, send: { prompt: "Alert! Threshold reached." } },
            logs: [`triggering on ${seen}`],
            calls: [],
            storeWrites: { set: {}, delete: [] },
          })
        },
      })

      yield* Effect.gen(function* () {
        const automation = yield* Automation.Service

        const created = yield* automation.create({
          name: "watcher",
          directory: "/tmp/app",
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          trigger: { type: "every", every: "1 minute" },
          action: { type: "code", code: "return null" },
        })

        assert.strictEqual(created.status, "active")
        assert.strictEqual(created.runCount, 0)

        yield* TestClock.adjust(Duration.minutes(1))
        const after1 = yield* automation.get(created.id)
        assert.strictEqual(after1.runCount, 1)
        assert.deepStrictEqual(after1.state, { seen: 1 })
        assert.strictEqual(harness.sent.length, 0)
        assert.strictEqual(harness.spawned.length, 0)

        yield* TestClock.adjust(Duration.minutes(1))
        const after2 = yield* automation.get(created.id)
        assert.strictEqual(after2.runCount, 2)
        assert.deepStrictEqual(after2.state, { seen: 2 })
        assert.strictEqual(harness.sent.length, 0)

        yield* TestClock.adjust(Duration.minutes(1))
        const after3 = yield* automation.get(created.id)
        assert.strictEqual(after3.runCount, 3)
        assert.strictEqual(after3.status, "done")
        assert.deepStrictEqual(after3.state, { seen: 3 })
        assert.strictEqual(harness.sent.length, 1)
        assert.strictEqual(harness.sent[0]?.id, SESSION_ID)
        assert.strictEqual(harness.sent[0]?.message, "Alert! Threshold reached.")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.effect(
    "coalesces 5 missed intervals during downtime into 1 run and does not commit state on failed delivery",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          failSend: true,
          executeCode: () =>
            Effect.succeed({
              ok: true,
              value: { state: { mutated: true }, done: true, send: { prompt: "Should fail delivery" } },
              logs: [],
              calls: [],
              storeWrites: { set: {}, delete: [] },
            }),
        })

        yield* Effect.gen(function* () {
          const automation = yield* Automation.Service
          const store = yield* AutomationStore.Service

          const created = yield* automation.create({
            name: "downtime-test",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            trigger: { type: "every", every: "5 minutes" },
            action: { type: "code", code: "return null" },
          })

          yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 27 * 60_000)
          yield* automation.tick

          const after = yield* store.get(created.id)
          assert.strictEqual(after.status, "paused")
          assert.strictEqual(after.runCount, 0)
          assert.isUndefined(after.state)
          assert.include(after.lastOutput ?? "", "missing session")
        }).pipe(Effect.provide(harness.layer))
      }),
  )

  it.effect("auto-pauses scheduled CodeMode automation after MAX_CODE_FAILURES = 3 consecutive transient errors", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        executeCode: () =>
          Effect.succeed({
            ok: false,
            error: { kind: "ScriptError", message: "transient upstream error" },
            logs: [],
            calls: [],
          }),
      })

      yield* Effect.gen(function* () {
        const automation = yield* Automation.Service

        const created = yield* automation.create({
          name: "flaky-gate",
          directory: "/tmp/app",
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          trigger: { type: "every", every: "5 minutes" },
          action: { type: "code", code: "return null" },
        })

        yield* TestClock.adjust(Duration.minutes(5))
        const after1 = yield* automation.get(created.id)
        assert.strictEqual(after1.status, "active")
        assert.strictEqual(after1.failures, 1)

        yield* TestClock.adjust(Duration.minutes(1))
        const after2 = yield* automation.get(created.id)
        assert.strictEqual(after2.status, "active")
        assert.strictEqual(after2.failures, 2)

        yield* TestClock.adjust(Duration.minutes(1))
        const after3 = yield* automation.get(created.id)
        assert.strictEqual(after3.status, "paused")
        assert.strictEqual(after3.failures, 3)
        assert.include(after3.lastOutput ?? "", "Paused after 3 failed runs")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.effect("rejects past at time and freezes relative at trigger to an ISO instant across pause/resume", () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* Effect.gen(function* () {
        const automation = yield* Automation.Service
        const base = Date.parse("2026-11-25T12:00:00Z")
        yield* TestClock.setTime(base)

        const pastExit = yield* automation
          .create({
            name: "past-at",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            trigger: { type: "at", at: "2026-11-25T11:59:00Z" },
            action: { type: "code", code: "return null" },
          })
          .pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(pastExit))

        const created = yield* automation.create({
          name: "frozen-at",
          directory: "/tmp/app",
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          trigger: { type: "at", at: "in 10 minutes", tz: "UTC" },
          action: { type: "code", code: "return null" },
        })

        assert.strictEqual(created.trigger.type, "at")

        if (created.trigger.type === "at") {
          assert.strictEqual(created.trigger.at, "2026-11-25T12:10:00.000Z")
        }

        yield* automation.pause(created.id)
        yield* TestClock.adjust(Duration.minutes(5))
        const resumed = yield* automation.resume(created.id)
        assert.strictEqual(resumed.nextDueAt, Date.parse("2026-11-25T12:10:00.000Z"))
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.effect(
    "forbids recursive tools at runtime, redacts webhookSecret from ledger, blocks secretHash bypass, and deduplicates concurrent webhooks",
    () =>
      Effect.gen(function* () {
        let codeExecs = 0

        const harness = makeHarness({
          executeCode: (request, executeOptions) =>
            Effect.gen(function* () {
              if (request.code.includes("automation.create")) {
                const allowed = executeOptions?.allowTool?.("automation.create")

                if (allowed !== undefined && Result.isFailure(allowed)) {
                  return {
                    ok: false,
                    error: { kind: "ToolDenied", message: allowed.failure },
                    logs: [],
                    calls: [],
                  }
                }
              }

              yield* Effect.yieldNow
              codeExecs += 1
              const input = request.bindings?.input as { readonly webhook?: { readonly payload?: { msg?: string } } }

              return {
                ok: true,
                value: {
                  send: { prompt: `Webhook: ${input.webhook?.payload?.msg ?? "none"}`, to: { agent: "general" } },
                },
                logs: [],
                calls: [],
                storeWrites: { set: {}, delete: [] },
              }
            }),
        })

        yield* Effect.gen(function* () {
          const automation = yield* Automation.Service
          const bus = yield* Bus.Service
          const { sql } = yield* Database.Service

          const emptyExit = yield* automation
            .create({
              name: "empty-code",
              directory: "/tmp/app",
              projectId: PROJECT_ID,
              trigger: { type: "webhook" },
              action: { type: "code", code: "   " },
            })
            .pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(emptyExit))

          const badAuto = yield* automation.create({
            name: "bad",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            trigger: { type: "every", every: "5 minutes" },
            action: { type: "code", code: "await tools.automation.create({})" },
          })

          const afterBadRun = yield* automation.runNow(badAuto.id)
          assert.strictEqual(afterBadRun.status, "paused")
          assert.include(afterBadRun.lastOutput ?? "", "cannot be used inside an automation")

          const secret = "top-secret-hmac-key"
          const secretHash = sha256Hex(secret)

          const created = yield* automation.create({
            name: "github-hook",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            trigger: { type: "webhook" },
            webhookSecret: secret,
            action: { type: "code", code: "return null" },
          })

          assert.strictEqual(created.trigger.type, "webhook")

          if (created.trigger.type === "webhook") {
            assert.strictEqual(created.trigger.secretHash, secretHash)
          }

          const loggedEvents = yield* Stream.runCollect(bus.log({ follow: false }))
          assert.notInclude(JSON.stringify(loggedEvents), secret)

          const rawEventRows = yield* sql<{ data: string }>`SELECT data FROM event`
          assert.isFalse(rawEventRows.some((row) => row.data.includes(secret)))

          const rawBody = JSON.stringify({ msg: "build-failed" })

          const bearerHashBypass = yield* automation
            .webhook({
              id: created.id,
              rawBody,
              payload: { msg: "build-failed" },
              headers: { authorization: `Bearer ${secretHash}` },
            })
            .pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(bearerHashBypass))

          const hmacHashBypass = yield* automation
            .webhook({
              id: created.id,
              rawBody,
              payload: { msg: "build-failed" },
              headers: {
                "x-vibest-signature-256": `sha256=${crypto.createHmac("sha256", secretHash).update(rawBody, "utf8").digest("hex")}`,
              },
            })
            .pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(hmacHashBypass))

          const hashOnly = yield* automation.create({
            name: "hash-only-hook",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            trigger: { type: "webhook", secretHash },
            action: { type: "code", code: "return null" },
          })

          const hashOnlyHmacBypass = yield* automation
            .webhook({
              id: hashOnly.id,
              rawBody,
              payload: { msg: "build-failed" },
              headers: {
                "x-vibest-signature-256": `sha256=${crypto.createHmac("sha256", secretHash).update(rawBody, "utf8").digest("hex")}`,
              },
            })
            .pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(hashOnlyHmacBypass))

          const sig = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")

          const [first, second] = yield* Effect.all(
            [
              automation.webhook({
                id: created.id,
                rawBody,
                payload: { msg: "build-failed" },
                headers: {
                  "x-vibest-signature-256": `sha256=${sig}`,
                  "x-idempotency-key": "evt-001",
                },
              }),
              automation.webhook({
                id: created.id,
                rawBody,
                payload: { msg: "build-failed" },
                headers: {
                  authorization: `Bearer ${secret}`,
                  "x-idempotency-key": "evt-001",
                },
              }),
            ],
            { concurrency: 2 },
          )

          assert.strictEqual(first.accepted, true)
          assert.strictEqual(second.accepted, true)
          assert.strictEqual([first.deduplicated, second.deduplicated].filter(Boolean).length, 1)
          assert.strictEqual(codeExecs, 1)
          assert.strictEqual((yield* automation.get(created.id)).runCount, 1)
          assert.strictEqual(harness.spawned.length, 1)
          assert.strictEqual(harness.spawned[0]?.prompt, "Webhook: build-failed")
        }).pipe(Effect.provide(harness.layer))
      }),
  )

  it.effect(
    "streams MCP SEP-3415 push events, fails closed on format keyword, matches key-order-independent const/enum, persists cursor, pauses on truncated:true, and replays ledger cleanly",
    () =>
      Effect.gen(function* () {
        const formatValidator = AutomationEventStream.compileSchemaValidator({ type: "string", format: "email" })
        assert.isUndefined(formatValidator)

        const constValidator = AutomationEventStream.compileSchemaValidator({
          const: { a: 1, b: { c: 2, d: 3 } },
        })

        assert.isDefined(constValidator)
        assert.isTrue(constValidator!({ b: { d: 3, c: 2 }, a: 1 }))

        const eventQueue = yield* Queue.unbounded<McpSchema.EventMessage>()

        const harness = makeHarness({
          eventTypes: [
            {
              name: "deploy.failed",
              delivery: ["push"],
              payloadSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
                additionalProperties: false,
              },
            },
            {
              name: "email.sent",
              delivery: ["push"],
              payloadSchema: {
                type: "object",
                properties: { to: { type: "string", format: "email" } },
              },
            },
          ],
          eventQueue,
          executeCode: (request) => {
            const input = request.bindings?.input as { readonly event?: { readonly data?: { service?: string } } }

            return Effect.succeed({
              ok: true,
              value: { send: { prompt: `Deploy failed: ${input.event?.data?.service}` } },
              logs: [],
              calls: [],
              storeWrites: { set: {}, delete: [] },
            })
          },
        })

        yield* Effect.gen(function* () {
          const automation = yield* Automation.Service
          const { sql } = yield* Database.Service

          const formatExit = yield* automation
            .create({
              name: "unsupported-format",
              directory: "/tmp/app",
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              trigger: { type: "event", server: "ci", event: "email.sent" },
              action: { type: "code", code: "return null" },
            })
            .pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(formatExit))

          const created = yield* automation.create({
            name: "deploy-watch",
            directory: "/tmp/app",
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            trigger: { type: "event", server: "ci", event: "deploy.failed" },
            action: { type: "code", code: "return null" },
          })

          yield* Queue.offer(eventQueue, { type: "active", cursor: "cur_1", truncated: false })
          yield* Queue.offer(eventQueue, {
            type: "event",
            eventId: "ev_1",
            name: "deploy.failed",
            timestamp: "2026-11-25T10:00:00Z",
            data: { service: "billing" },
            cursor: "cur_2",
          })

          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* TestClock.adjust(Duration.millis(10))

          const afterEvent = yield* automation.get(created.id)
          assert.strictEqual(afterEvent.runCount, 1)
          assert.strictEqual(afterEvent.eventCursor?.cursor, "cur_2")
          assert.strictEqual(afterEvent.eventCursor?.lastEventId, "ev_1")
          assert.strictEqual(harness.sent.length, 1)
          assert.strictEqual(harness.sent[0]?.message, "Deploy failed: billing")

          yield* Queue.offer(eventQueue, { type: "active", cursor: "cur_3", truncated: true })
          yield* Effect.yieldNow
          yield* TestClock.adjust(Duration.millis(10))

          const afterTrunc = yield* automation.get(created.id)
          assert.strictEqual(afterTrunc.status, "paused")
          assert.include(afterTrunc.lastOutput ?? "", "could not replay")

          const diff = yield* equalToReplay(sql).pipe(
            Effect.provide(Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))),
          )

          assert.isUndefined(diff)
        }).pipe(Effect.provide(harness.layer))
      }),
  )

  it.effect("upgrades a pre-automation SQLite database cleanly via checkLedger and open() while preserving rows", () =>
    Effect.gen(function* () {
      const preAutomationLayer = Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const bus = yield* Bus.Service

        for (const statement of [...LOG_SCHEMA, ...BASELINE_PROJECTION_SCHEMA]) {
          yield* sql.unsafe(statement)
        }

        yield* sql`INSERT INTO kv (key, value) VALUES ('ledger', ${randomId()})`
        yield* bus.transaction(
          bus.publish(ProjectEvent.Created, { projectId: PROJECT_ID, directory: "/tmp/legacy", repositories: [] }),
        )

        assert.strictEqual(yield* inspectSchema(), "ready")

        yield* checkLedger(sql).pipe(
          Effect.provide(Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))),
        )

        yield* open()

        const applied = yield* sql<{ id: string }>`SELECT id FROM migration`
        assert.deepStrictEqual(
          applied.map((row) => row.id),
          [AUTOMATION_MIGRATION_ID],
        )

        const projects = yield* sql<{ id: string }>`SELECT id FROM project`
        assert.deepStrictEqual(
          projects.map((row) => row.id),
          [PROJECT_ID],
        )

        assert.strictEqual(yield* inspectSchema(), "ready")
      }).pipe(Effect.provide(preAutomationLayer))
    }),
  )

  it("decodes Automation.CodeResult strictly with onExcessProperty error", () => {
    const ok = AutomationSchema.decodeCodeResult({ state: { a: 1 }, done: false })
    assert.isTrue(Result.isSuccess(ok))

    const nullOk = AutomationSchema.decodeCodeResult(null)
    assert.isTrue(Result.isSuccess(nullOk))

    const excess = AutomationSchema.decodeCodeResult({ state: 1, unexpected: true })
    assert.isTrue(Result.isFailure(excess))
  })
})
