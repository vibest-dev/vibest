import assert from "node:assert/strict";

import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Logger, References, Stream } from "effect";
import { beforeEach, describe, vi } from "vitest";

import { makeClaudeCodeAdapter } from "../../../src/harness/claude-code/adapter";
import { makeClaudeCodeAgent } from "../../../src/harness/claude-code/agent";
import { structured, type LogRecord } from "../../log-record";
import { NodePlatformLayer } from "../../platform";

const mockQuery = vi.hoisted(() =>
  vi.fn<
    (input: { prompt: AsyncIterable<sdk.SDKUserMessage>; options: sdk.Options }) => sdk.Query
  >(),
);
const mockGetSessionInfo = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  getSessionInfo: mockGetSessionInfo,
}));

// The agent locates the `claude` binary through FileSystem/Path; every test
// here runs against the real Node platform services.
const claudeAgent = (options?: Parameters<typeof makeClaudeCodeAgent>[0]) =>
  makeClaudeCodeAgent(options).pipe(Effect.provide(NodePlatformLayer));

type FakeQuery = sdk.Query & {
  readonly supportedCommands: ReturnType<typeof vi.fn>;
  readonly supportedModels: ReturnType<typeof vi.fn>;
  readonly mcpServerStatus: ReturnType<typeof vi.fn>;
  readonly setModel: ReturnType<typeof vi.fn>;
  readonly interrupt: ReturnType<typeof vi.fn>;
};

let messages: sdk.SDKMessage[];
let queryInstance: FakeQuery;

const makeFakeQuery = (
  prompt: AsyncIterable<sdk.SDKUserMessage>,
  failAfterInput = false,
  failWhileIdle?: () => void,
): FakeQuery => {
  const input = prompt[Symbol.asyncIterator]();
  let needsInput = true;
  const query = {
    next: vi.fn<
      () => Promise<{ done: false; value: sdk.SDKMessage } | { done: true; value: undefined }>
    >(async () => {
      if (failWhileIdle) {
        const fail = failWhileIdle;
        failWhileIdle = undefined;
        fail();
        throw new Error("idle query failed");
      }
      if (needsInput) {
        const nextInput = await input.next();
        if (nextInput.done) return { done: true as const, value: undefined };
        needsInput = false;
        if (failAfterInput) throw new Error("query failed");
      }
      const value = messages.shift();
      if (!value) return new Promise(() => undefined);
      if (value.type === "result") needsInput = true;
      return { done: false as const, value };
    }),
    supportedCommands: vi.fn<() => Promise<unknown[]>>(async () => [
      { name: "read", description: "Read files", argumentHint: "<file>" },
    ]),
    supportedModels: vi.fn<() => Promise<unknown[]>>(async () => [
      { value: "sonnet", displayName: "Sonnet", description: "Fast" },
    ]),
    mcpServerStatus: vi.fn<() => Promise<unknown[]>>(async () => [
      { name: "filesystem", status: "connected" as const },
    ]),
    setModel: vi.fn<(model: string) => Promise<void>>(async () => undefined),
    interrupt: vi.fn<() => Promise<void>>(async () => undefined),
    [Symbol.asyncIterator]() {
      return query;
    },
  };
  return query as unknown as FakeQuery;
};

const lastOptions = (): sdk.Options =>
  (mockQuery.mock.calls.at(-1) as unknown as [{ options: sdk.Options }])[0].options;

describe("ClaudeCodeAgent", () => {
  beforeEach(() => {
    process.env["VIBEST_CLAUDE_EXECUTABLE"] = "/fake/claude";
    messages = [];
    mockQuery.mockReset().mockImplementation(({ prompt }) => {
      queryInstance = makeFakeQuery(prompt);
      return queryInstance;
    });
    mockGetSessionInfo.mockReset();
  });

  it.effect("keeps Vibest and Claude session identities distinct in SDK stderr", () => {
    const records: Array<LogRecord> = [];
    const capture = Layer.merge(
      Logger.layer([
        Logger.map(structured, (record) => {
          records.push(record);
        }),
      ]),
      Layer.succeed(References.MinimumLogLevel, "Debug"),
    );

    return Effect.gen(function* () {
      const agent = yield* claudeAgent();
      const { sessionId: harnessSessionId } = yield* agent.session.create();
      lastOptions().stderr?.("sdk diagnostic");
      yield* Effect.yieldNow;

      const record = records.find((candidate) => candidate.message === "sdk diagnostic");
      assert.equal(record?.annotations.sessionId, "vibest-session");
      assert.equal(record?.annotations.projectId, "project-1");
      assert.equal(record?.annotations.harnessSessionId, harnessSessionId);
      yield* agent.session.abort(harnessSessionId);
    }).pipe(
      Effect.annotateLogs({ sessionId: "vibest-session", projectId: "project-1" }),
      Effect.provide(capture),
    );
  });

  it.effect("passes the server environment to the Claude Code process", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent({
        env: {
          ...process.env,
          HTTPS_PROXY: "http://desktop-proxy.test:8443",
        },
      });
      const { sessionId } = yield* agent.session.create();

      assert.equal(lastOptions().env?.["HTTPS_PROXY"], "http://desktop-proxy.test:8443");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("leaves the permission mode to the SDK default when none is provided", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();

      assert.equal(lastOptions().permissionMode, undefined);
      // The bypass capability is always enabled so a session can be switched to
      // "bypassPermissions" at runtime; the active mode stays the SDK default.
      assert.equal(lastOptions().allowDangerouslySkipPermissions, true);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("forwards bypass permission mode and the required safety flag", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent({ permissionMode: "bypassPermissions" });
      const { sessionId } = yield* agent.session.create();

      assert.equal(lastOptions().permissionMode, "bypassPermissions");
      assert.equal(lastOptions().allowDangerouslySkipPermissions, true);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("creates a scoped session and exposes SDK capabilities as Effects", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();

      assert.match(
        sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(lastOptions().sessionId, sessionId);
      assert.deepEqual(yield* agent.session.getSupportedCommands(sessionId), [
        { name: "read", description: "Read files", argumentHint: "<file>" },
      ]);
      assert.deepEqual(yield* agent.session.getSupportedModels(sessionId), [
        { value: "sonnet", displayName: "Sonnet", description: "Fast" },
      ]);
      assert.deepEqual(yield* agent.session.getMcpServers(sessionId), [
        { name: "filesystem", status: "connected" },
      ]);
      yield* agent.session.abort(sessionId);
      assert.equal(queryInstance.interrupt.mock.calls.length, 1);
    }),
  );

  it.effect("streams SDK output and preserves per-turn model selection", () =>
    Effect.gen(function* () {
      messages = [
        { type: "system", subtype: "init", session_id: "sdk-session" } as sdk.SDKMessage,
        { type: "result", subtype: "success" } as sdk.SDKMessage,
      ];
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();

      yield* agent.session.setModel(sessionId, "opus");
      const prompt = yield* agent.session.prompt({
        sessionId,
        message: { role: "user", content: "hello" },
      });
      const output = yield* Stream.runCollect(prompt.output);

      assert.deepEqual(
        Array.from(output, (message) => message.type),
        ["system", "result"],
      );
      assert.deepEqual(queryInstance.setModel.mock.calls, [["opus"]]);
    }),
  );

  it.effect("reports an SDK query crash while the adapter session is idle", () =>
    Effect.gen(function* () {
      let reportNativeFailure: () => void = () => undefined;
      const nativeFailed = new Promise<void>((resolve) => {
        reportNativeFailure = resolve;
      });
      mockQuery.mockImplementation(({ prompt }) => {
        queryInstance = makeFakeQuery(prompt, false, reportNativeFailure);
        return queryInstance;
      });
      const agent = yield* claudeAgent();
      const session = yield* makeClaudeCodeAdapter(agent).open({ cwd: "/tmp" });
      const crashSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(session.events, (event) =>
        event.body.type === "session.crashed"
          ? Deferred.succeed(crashSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* Effect.promise(() => nativeFailed);
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      assert.equal(
        yield* Deferred.isDone(crashSeen),
        true,
        "idle Claude adapter session did not publish session.crashed",
      );
    }),
  );

  it.effect("exposes prompt output through the unified adapter event stream", () =>
    Effect.gen(function* () {
      messages = [
        { type: "system", subtype: "init", session_id: "sdk-session" } as sdk.SDKMessage,
        { type: "result", subtype: "success" } as sdk.SDKMessage,
      ];
      const agent = yield* claudeAgent();
      const session = yield* makeClaudeCodeAdapter(agent).open({ cwd: "/tmp" });
      // The session seeds a runtime it has just acquired by calling the very
      // same setter, so driving it directly is what that path exercises.
      yield* session.setModel("opus");
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({
        parts: [{ type: "text", text: "hello" }],
      });
      const events = yield* Fiber.join(collected);

      assert.equal(typeof receipt.turnId, "string");
      assert.deepEqual(
        Array.from(events, (event) => event.body.type),
        ["session.turn.started", "start", "finish", "session.turn.ended"],
      );
      assert.deepEqual(queryInstance.setModel.mock.calls, [["opus"]]);
      yield* session.close;
    }),
  );

  it.effect("rejects a concurrent turn while the previous turn is unfinished", () =>
    Effect.gen(function* () {
      messages = [{ type: "system", subtype: "init" } as sdk.SDKMessage];
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();
      const first = yield* agent.session.prompt({
        sessionId,
        message: { role: "user", content: "first" },
      });
      yield* Stream.runHead(first.output);

      const error = yield* agent.session
        .prompt({
          sessionId,
          message: { role: "user", content: "second" },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "TurnAlreadyRunning");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("evicts a session when the SDK output pump fails", () =>
    Effect.gen(function* () {
      let build = 0;
      mockQuery.mockImplementation(({ prompt }) => {
        build += 1;
        queryInstance = makeFakeQuery(prompt, build === 1);
        return queryInstance;
      });
      mockGetSessionInfo.mockResolvedValue({ sessionId: "present" });
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();

      const first = yield* agent.session.prompt({
        sessionId,
        message: { role: "user", content: "fail" },
      });
      const firstExit = yield* Stream.runCollect(first.output).pipe(Effect.exit);
      assert.equal(firstExit._tag, "Failure");

      yield* Effect.eventually(
        agent.session.getSupportedCommands(sessionId).pipe(
          Effect.filterOrFail(
            () => build === 2,
            () => new Error("session has not resumed yet"),
          ),
        ),
      );
      assert.equal(build, 2);
      assert.equal(lastOptions().resume, sessionId);
    }),
  );

  it.effect("single-flights concurrent resume and fails when no transcript exists", () =>
    Effect.gen(function* () {
      mockGetSessionInfo.mockResolvedValue({ sessionId: "present" });
      const agent = yield* claudeAgent();
      const sessionId = "019f6013-0000-7000-8000-000000000002";

      yield* Effect.all(
        [
          agent.session.getSupportedCommands(sessionId),
          agent.session.getSupportedModels(sessionId),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(mockGetSessionInfo.mock.calls.length, 1);
      assert.equal(mockQuery.mock.calls.length, 1);
      assert.equal(lastOptions().resume, sessionId);
      assert.equal(lastOptions().sessionId, undefined);

      mockGetSessionInfo.mockResolvedValue(undefined);
      const missing = yield* claudeAgent();
      const error = yield* missing.session
        .getSupportedCommands("019f6013-0000-7000-8000-000000000003")
        .pipe(Effect.flip);
      assert.equal(error._tag, "SessionNotResumable");
    }),
  );

  it.effect("denies pending SDK permissions when the session scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const canUseTool = lastOptions().canUseTool;
      assert.ok(canUseTool);

      const permission = canUseTool!(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-1",
          agentID: undefined,
          blockedPath: undefined,
          decisionReason: undefined,
          requestId: "request-close",
        },
      );
      yield* Fiber.join(requestFiber);
      yield* agent.session.abort(sessionId);

      assert.deepEqual(yield* Effect.tryPromise(() => permission), {
        behavior: "deny",
        message: "Request aborted due to session termination",
        interrupt: true,
      });
    }),
  );

  it.effect("bridges SDK permission promises through Deferred", () =>
    Effect.gen(function* () {
      const agent = yield* claudeAgent();
      const { sessionId } = yield* agent.session.create();
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const canUseTool = lastOptions().canUseTool;
      assert.ok(canUseTool);

      const permission = canUseTool!(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-1",
          agentID: undefined,
          blockedPath: undefined,
          decisionReason: undefined,
          requestId: "request-1",
        },
      );
      const request = yield* Fiber.join(requestFiber);
      assert.equal(request._tag, "Some");
      if (request._tag === "Some") {
        yield* agent.session.respondPermission(sessionId, request.value.requestId, {
          behavior: "allow",
          updatedInput: { command: "pwd" },
        });
      }

      assert.deepEqual(yield* Effect.tryPromise(() => permission), {
        behavior: "allow",
        updatedInput: { command: "pwd" },
      });
    }),
  );
});
