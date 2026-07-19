import * as NodeAssert from "node:assert/strict";

import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { beforeEach, describe, vi } from "vitest";

import { makeClaudeCodeAdapter } from "../../../src/harness/claude-code/adapter";
import { makeClaudeCodeAgent } from "../../../src/harness/claude-code/agent";

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

  it.effect("passes the server environment to the Claude Code process", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent({
        env: {
          ...process.env,
          HTTPS_PROXY: "http://desktop-proxy.test:8443",
        },
      });
      const { sessionId } = yield* agent.session.create;

      NodeAssert.equal(lastOptions().env?.["HTTPS_PROXY"], "http://desktop-proxy.test:8443");
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("leaves the permission mode to the SDK default when none is provided", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;

      NodeAssert.equal(lastOptions().permissionMode, undefined);
      NodeAssert.equal(lastOptions().allowDangerouslySkipPermissions, undefined);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("forwards bypass permission mode and the required safety flag", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent({ permissionMode: "bypassPermissions" });
      const { sessionId } = yield* agent.session.create;

      NodeAssert.equal(lastOptions().permissionMode, "bypassPermissions");
      NodeAssert.equal(lastOptions().allowDangerouslySkipPermissions, true);
      yield* agent.session.abort(sessionId);
    }),
  );

  it.effect("creates a scoped session and exposes SDK capabilities as Effects", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;

      NodeAssert.match(
        sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      NodeAssert.equal(lastOptions().sessionId, sessionId);
      NodeAssert.deepStrictEqual(yield* agent.session.getSupportedCommands(sessionId), [
        { name: "read", description: "Read files", argumentHint: "<file>" },
      ]);
      NodeAssert.deepStrictEqual(yield* agent.session.getSupportedModels(sessionId), [
        { value: "sonnet", displayName: "Sonnet", description: "Fast" },
      ]);
      NodeAssert.deepStrictEqual(yield* agent.session.getMcpServers(sessionId), [
        { name: "filesystem", status: "connected" },
      ]);
      yield* agent.session.abort(sessionId);
      NodeAssert.equal(queryInstance.interrupt.mock.calls.length, 1);
    }),
  );

  it.effect("streams SDK output and preserves per-turn model selection", () =>
    Effect.gen(function* () {
      messages = [
        { type: "system", subtype: "init", session_id: "sdk-session" } as sdk.SDKMessage,
        { type: "result", subtype: "success" } as sdk.SDKMessage,
      ];
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;

      yield* agent.session.setModel(sessionId, "opus");
      const prompt = yield* agent.session.prompt({
        sessionId,
        message: { role: "user", content: "hello" },
      });
      const output = yield* Stream.runCollect(prompt.output);

      NodeAssert.deepStrictEqual(
        Array.from(output, (message) => message.type),
        ["system", "result"],
      );
      NodeAssert.deepStrictEqual(queryInstance.setModel.mock.calls, [["opus"]]);
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
      const agent = yield* makeClaudeCodeAgent();
      const session = yield* makeClaudeCodeAdapter(agent).open({ workspacePath: "/tmp" });
      const crashSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(session.events, (event) =>
        event.body.type === "session.crashed"
          ? Deferred.succeed(crashSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* Effect.promise(() => nativeFailed);
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });

      NodeAssert.equal(
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
      const agent = yield* makeClaudeCodeAgent();
      const session = yield* makeClaudeCodeAdapter(agent).open({ workspacePath: "/tmp" });
      const collected = yield* Effect.forkChild(
        Stream.runCollect(
          session.events.pipe(
            Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
          ),
        ),
      );

      const receipt = yield* session.prompt({
        model: "opus",
        parts: [{ type: "text", text: "hello" }],
      });
      const events = yield* Fiber.join(collected);

      NodeAssert.equal(typeof receipt.turnId, "string");
      NodeAssert.deepStrictEqual(
        Array.from(events, (event) => event.body.type),
        ["session.turn.started", "start", "finish", "session.turn.ended"],
      );
      NodeAssert.deepStrictEqual(queryInstance.setModel.mock.calls, [["opus"]]);
      yield* session.close;
    }),
  );

  it.effect("rejects a concurrent turn while the previous turn is unfinished", () =>
    Effect.gen(function* () {
      messages = [{ type: "system", subtype: "init" } as sdk.SDKMessage];
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;
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
      NodeAssert.equal(error._tag, "TurnAlreadyRunning");
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
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;

      const first = yield* agent.session.prompt({
        sessionId,
        message: { role: "user", content: "fail" },
      });
      const firstExit = yield* Stream.runCollect(first.output).pipe(Effect.exit);
      NodeAssert.equal(firstExit._tag, "Failure");

      yield* Effect.eventually(
        agent.session.getSupportedCommands(sessionId).pipe(
          Effect.filterOrFail(
            () => build === 2,
            () => new Error("session has not resumed yet"),
          ),
        ),
      );
      NodeAssert.equal(build, 2);
      NodeAssert.equal(lastOptions().resume, sessionId);
    }),
  );

  it.effect("single-flights concurrent resume and fails when no transcript exists", () =>
    Effect.gen(function* () {
      mockGetSessionInfo.mockResolvedValue({ sessionId: "present" });
      const agent = yield* makeClaudeCodeAgent();
      const sessionId = "019f6013-0000-7000-8000-000000000002";

      yield* Effect.all(
        [
          agent.session.getSupportedCommands(sessionId),
          agent.session.getSupportedModels(sessionId),
        ],
        { concurrency: "unbounded" },
      );
      NodeAssert.equal(mockGetSessionInfo.mock.calls.length, 1);
      NodeAssert.equal(mockQuery.mock.calls.length, 1);
      NodeAssert.equal(lastOptions().resume, sessionId);
      NodeAssert.equal(lastOptions().sessionId, undefined);

      mockGetSessionInfo.mockResolvedValue(undefined);
      const missing = yield* makeClaudeCodeAgent();
      const error = yield* missing.session
        .getSupportedCommands("019f6013-0000-7000-8000-000000000003")
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "SessionNotResumable");
    }),
  );

  it.effect("denies pending SDK permissions when the session scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const canUseTool = lastOptions().canUseTool;
      NodeAssert.ok(canUseTool);

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

      NodeAssert.deepStrictEqual(yield* Effect.tryPromise(() => permission), {
        behavior: "deny",
        message: "Request aborted due to session termination",
        interrupt: true,
      });
    }),
  );

  it.effect("bridges SDK permission promises through Deferred", () =>
    Effect.gen(function* () {
      const agent = yield* makeClaudeCodeAgent();
      const { sessionId } = yield* agent.session.create;
      const requestFiber = yield* Stream.runHead(agent.session.requestPermission(sessionId)).pipe(
        Effect.forkChild,
      );
      const canUseTool = lastOptions().canUseTool;
      NodeAssert.ok(canUseTool);

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
      NodeAssert.equal(request._tag, "Some");
      if (request._tag === "Some") {
        yield* agent.session.respondPermission(sessionId, request.value.requestId, {
          behavior: "allow",
          updatedInput: { command: "pwd" },
        });
      }

      NodeAssert.deepStrictEqual(yield* Effect.tryPromise(() => permission), {
        behavior: "allow",
        updatedInput: { command: "pwd" },
      });
    }),
  );
});
