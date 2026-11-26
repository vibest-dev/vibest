import { assert, describe, it } from "@effect/vitest"
import { fromBytes, Host, Runtime, toBytes } from "@vibest/codemode/index"
import { CodeModeRuntime, type ToolDefinition } from "@vibest/codemode/service"
import { CodeMode } from "@vibest/schema/codemode"
import { Deferred, Duration, Effect, Fiber, Option, Predicate, Ref, Result, Schema } from "effect"

describe("@vibest/codemode psychoscript sandbox", () => {
  it.effect("executes async scripts, captures console logs, and binds input", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const result = yield* runtime.execute({
        code: `
          console.log("hello", input.name);
          console.warn("count:", input.count);
          return { greeting: "hi " + input.name, doubled: input.count * 2 };
        `,
        tools: [],
        bindings: { input: { name: "vibest", count: 21 } },
      })

      assert.strictEqual(result.ok, true)

      if (result.ok) {
        assert.deepStrictEqual(result.value, { greeting: "hi vibest", doubled: 42 })
        assert.deepStrictEqual(result.logs, ["hello vibest", "[warn] count: 21"])
        assert.deepStrictEqual(result.calls, [])
        assert.deepStrictEqual(result.storeWrites, { set: {}, delete: [] })
      }
    }),
  )

  it.effect("confines environment with zero fetch, process, timers, or host module access", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const result = yield* runtime.execute({
        code: `
          let fsBlocked = false;
          try {
            require("node:fs");
          } catch {
            fsBlocked = true;
          }
          return {
            hasFetch: typeof fetch !== "undefined",
            hasProcess: typeof process !== "undefined",
            hasSetTimeout: typeof setTimeout !== "undefined",
            fsBlocked,
          };
        `,
        tools: [],
      })

      assert.strictEqual(result.ok, true)

      if (result.ok) {
        assert.deepStrictEqual(result.value, {
          hasFetch: false,
          hasProcess: false,
          hasSetTimeout: false,
          fsBlocked: true,
        })
      }
    }),
  )

  it.effect("terminates infinite CPU loops deterministically via timeoutMs", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const result = yield* runtime.execute({
        code: "while (true) {}",
        tools: [],
        limits: { timeoutMs: 150 },
      })

      assert.strictEqual(result.ok, false)

      if (!result.ok) {
        assert.strictEqual(result.error.kind, "Timeout")
      }
    }),
  )

  it.effect("commits transactional store/load writes on success and rolls back on error", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const okResult = yield* runtime.execute({
        code: `
          const prev = load("counter") ?? 0;
          store("counter", prev + 1);
          store("obsolete", undefined);
          return load("counter");
        `,
        tools: [],
        state: { counter: 4, obsolete: "bye" },
      })

      assert.strictEqual(okResult.ok, true)

      if (okResult.ok) {
        assert.strictEqual(okResult.value, 5)
        assert.deepStrictEqual(okResult.storeWrites, { set: { counter: 5 }, delete: ["obsolete"] })
      }

      const failResult = yield* runtime.execute({
        code: `
          store("counter", 999);
          throw new Error("boom");
        `,
        tools: [],
        state: { counter: 5 },
      })

      assert.strictEqual(failResult.ok, false)

      if (!failResult.ok) {
        assert.strictEqual(failResult.error.kind, "ScriptError")
        assert.include(failResult.error.message, "boom")
        assert.isFalse("storeWrites" in failResult)
      }
    }),
  )

  it.effect("bounds console log capture to maxLogBytes", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const result = yield* runtime.execute({
        code: `
          for (let i = 0; i < 200; i++) {
            console.log("x".repeat(500));
          }
          return true;
        `,
        tools: [],
        limits: { maxLogBytes: 2048 },
      })

      assert.strictEqual(result.ok, true)

      if (result.ok) {
        const totalBytes = result.logs.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0)
        assert.isAtMost(totalBytes, 2048 + 256)
      }
    }),
  )

  it.effect("enforces maxToolCalls limit", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()

      const tools: ReadonlyArray<ToolDefinition> = [
        {
          server: "math",
          name: "inc",
          execute: (args) => {
            const n = Predicate.isObject(args) && !Array.isArray(args) && Predicate.isNumber(args.n) ? args.n : 0

            return Effect.succeed(n + 1)
          },
        },
      ]

      const result = yield* runtime.execute({
        code: `
          let n = 0;
          for (let i = 0; i < 5; i++) {
            n = await tools.math.inc({ n });
          }
          return n;
        `,
        tools,
        limits: { maxToolCalls: 2 },
      })

      assert.strictEqual(result.ok, false)

      if (!result.ok) {
        assert.strictEqual(result.error.kind, "ToolLimit")
      }
    }),
  )

  it.effect("immediately interrupts in-flight slow tool fiber when parent execute fiber is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)

      const tools: ReadonlyArray<ToolDefinition> = [
        {
          server: "slow",
          name: "wait",
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.sleep(Duration.seconds(30))),
              Effect.onInterrupt(() => Ref.set(interrupted, true)),
              Effect.as("never"),
            ),
        },
      ]

      const fiber = yield* Effect.forkChild(
        runtime.execute({
          code: "return await tools.slow.wait({});",
          tools,
        }),
      )

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(yield* Ref.get(interrupted), true)
    }),
  )

  it.effect("blocks eval and Function dynamic code execution with zero spy calls", () =>
    Effect.gen(function* () {
      const runtime = yield* CodeModeRuntime.make()
      const spyCalls = yield* Ref.make(0)

      const tools: ReadonlyArray<ToolDefinition> = [
        {
          server: "srv",
          name: "fn",
          execute: () => Ref.updateAndGet(spyCalls, (n) => n + 1).pipe(Effect.map((call) => ({ pwned: true, call }))),
        },
      ]

      const payloads = [
        'return await eval("tools.srv.fn()");',
        'return await (0, eval)("tools.srv.fn()");',
        'return await Function("return tools.srv.fn()")();',
        'return await (() => {}).constructor("return tools.srv.fn()")();',
      ]

      for (const code of payloads) {
        const res = yield* runtime.execute({ code, tools })
        assert.strictEqual(res.ok, false, `expected failure for: ${code}`)
      }

      assert.strictEqual(yield* Ref.get(spyCalls), 0)
    }),
  )

  it.effect(
    "dispatches arbitrary tools lazily via Host.namespace, runs Promise.all concurrently, and enforces allowTool",
    () =>
      Effect.gen(function* () {
        const runtime = yield* CodeModeRuntime.make()
        const called = yield* Ref.make<Array<string>>([])

        const callTool = (server: string, tool: string, args: Schema.Json | undefined) =>
          Ref.update(called, (list) => [...list, `${server}.${tool}`]).pipe(
            Effect.as({ server, tool, args: args ?? null } as Schema.Json),
          )

        const okRes = yield* runtime.execute({
          code: `
          const [a, b] = await Promise.all([
            tools.github.list_issues({ state: "open" }),
            tools["slack-prod"]["post-message"]({ text: "hi" }),
          ]);
          return { a, b };
        `,
          callTool,
        })

        assert.strictEqual(okRes.ok, true)

        if (okRes.ok) {
          assert.deepStrictEqual(okRes.value, {
            a: { server: "github", tool: "list_issues", args: { state: "open" } },
            b: { server: "slack-prod", tool: "post-message", args: { text: "hi" } },
          })
          assert.sameMembers([...(yield* Ref.get(called))], ["github.list_issues", "slack-prod.post-message"])
        }

        yield* Ref.set(called, [])

        for (const code of [
          "return await tools.automation.create({ name: 'loop' });",
          "try { await tools.automation.create({ name: 'loop' }); } catch {} return 'escaped';",
          "const t = tools; return await t['automation']['create']({});",
        ]) {
          const denied = yield* runtime.execute({
            code,
            callTool,
            allowTool: (path) =>
              path.startsWith("automation.") ? Result.fail(`Tool "${path}" is forbidden`) : Result.succeed(undefined),
          })

          assert.strictEqual(denied.ok, false, code)

          if (!denied.ok) {
            assert.strictEqual(denied.error.kind, "ToolDenied", code)
            assert.include(denied.error.message, "automation.create")
          }
        }

        assert.deepStrictEqual(yield* Ref.get(called), [])

        const syntaxRes = yield* runtime.execute({
          code: "const x = ;",
          tools: [],
        })

        assert.strictEqual(syntaxRes.ok, false)

        if (!syntaxRes.ok) {
          assert.strictEqual(syntaxRes.error.kind, "ParseError")
        }
      }),
  )

  it.effect("round-trips durable suspend -> toBytes -> fromBytes -> resume cleanly with Effect", () =>
    Effect.gen(function* () {
      const pausedAtStep = yield* Deferred.make<void>()
      const unblockResume = yield* Deferred.make<void>()

      const rt = Runtime.make({
        globals: () => ({
          waitStep: Host.fn(
            ([label]) =>
              Deferred.succeed(pausedAtStep, undefined).pipe(
                Effect.andThen(Deferred.await(unblockResume)),
                Effect.as(`resumed:${String(label)}`),
              ),
            { type: "async", idempotent: true },
          ),
        }),
      })

      const program = rt.program(`
        const first = 20;
        const tag = await waitStep("checkpoint");
        return { sum: first + 22, tag };
      `)

      const runFiber = yield* Effect.forkChild(program.run())
      yield* Deferred.await(pausedAtStep)
      const suspended = yield* program.suspend()
      yield* Fiber.join(runFiber)

      assert.strictEqual(suspended.ok, "suspended")

      if (suspended.ok === "suspended") {
        const bytes = toBytes(suspended.state)
        assert.isAbove(bytes.byteLength, 0)
        assert.isDefined(fromBytes(bytes))
        yield* Deferred.succeed(unblockResume, undefined)
        const restored = yield* rt.resume(bytes).run()
        assert.strictEqual(restored.ok, true)

        if (restored.ok === true) {
          assert.deepStrictEqual(restored.value, { sum: 42, tag: "resumed:checkpoint" })
        }
      }
    }),
  )

  it.effect("validates and clamps ExecutionLimits and ignores colliding intrinsic bindings", () =>
    Effect.gen(function* () {
      const decodeLimits = Schema.decodeUnknownOption(CodeMode.ExecutionLimits)
      assert.isTrue(Option.isNone(decodeLimits({ timeoutMs: Number.NaN })))
      assert.isTrue(Option.isNone(decodeLimits({ timeoutMs: 0 })))
      assert.isTrue(Option.isNone(decodeLimits({ maxToolCalls: 1e9 })))
      assert.isTrue(Option.isNone(decodeLimits({ maxLogBytes: 1e12 })))
      assert.isTrue(Option.isSome(decodeLimits({ timeoutMs: 5_000, maxToolCalls: 10 })))

      const runtime = yield* CodeModeRuntime.make()

      const res = yield* runtime.execute({
        code: 'return { ok: input.ok, jsonWorks: typeof JSON.stringify({ a: 1 }) === "string" };',
        tools: [],
        bindings: { JSON: { hacked: true }, input: { ok: true } },
        limits: { timeoutMs: Number.NaN },
      })

      assert.strictEqual(res.ok, true)

      if (res.ok) {
        assert.deepStrictEqual(res.value, { ok: true, jsonWorks: true })
      }
    }),
  )
})
