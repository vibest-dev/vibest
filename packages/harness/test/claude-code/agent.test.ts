import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Session, SessionNotResumableError } from "../../src/claude-code/agent";

const mockQuery = vi.hoisted(() => vi.fn<() => unknown>());
const mockGetSessionInfo = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  getSessionInfo: mockGetSessionInfo,
}));

describe("Session", () => {
  let session: Session;
  let mockQueryInstance: {
    supportedCommands: ReturnType<typeof vi.fn>;
    supportedModels: ReturnType<typeof vi.fn>;
    mcpServerStatus: ReturnType<typeof vi.fn>;
    accountInfo: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    session = new Session();
    mockQueryInstance = {
      supportedCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue([
        {
          name: "read",
          description: "Read file contents",
          argumentHint: "<file>",
        },
        {
          name: "write",
          description: "Write to file",
          argumentHint: "<file> <content>",
        },
        {
          name: "edit",
          description: "Edit file",
          argumentHint: "<file> <search> <replace>",
        },
        {
          name: "bash",
          description: "Run bash command",
          argumentHint: "<command>",
        },
      ]),
      supportedModels: vi.fn<() => Promise<unknown>>().mockResolvedValue([
        {
          value: "claude-sonnet-4-5",
          displayName: "Sonnet 4.5",
          description: "Fast and capable",
        },
        {
          value: "claude-opus-4-5",
          displayName: "Opus 4.5",
          description: "Most powerful",
        },
      ]),
      mcpServerStatus: vi.fn<() => Promise<unknown>>().mockResolvedValue([
        {
          name: "filesystem",
          status: "connected",
          serverInfo: { name: "filesystem", version: "1.0.0" },
        },
        {
          name: "git",
          status: "connected",
          serverInfo: { name: "git", version: "1.0.0" },
        },
      ]),
      accountInfo: vi.fn<() => Promise<unknown>>().mockResolvedValue({ plan: "pro" }),
      interrupt: vi.fn<() => void>(),
    };

    mockQuery.mockReturnValue(mockQueryInstance);
  });

  it("should create a session with only sessionId", async () => {
    const result = await session.create();

    expect(result).toHaveProperty("sessionId");
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ); // UUID v7 format

    // Verify the session is stored
    const storedSession = session.get(result.sessionId);
    expect(storedSession).toBeDefined();
  });

  it("should fetch supported commands for a session", async () => {
    const { sessionId } = await session.create();

    const commands = await session.getSupportedCommands(sessionId);

    expect(commands).toEqual([
      {
        name: "read",
        description: "Read file contents",
        argumentHint: "<file>",
      },
      {
        name: "write",
        description: "Write to file",
        argumentHint: "<file> <content>",
      },
      {
        name: "edit",
        description: "Edit file",
        argumentHint: "<file> <search> <replace>",
      },
      {
        name: "bash",
        description: "Run bash command",
        argumentHint: "<command>",
      },
    ]);
    expect(mockQueryInstance.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it("should fetch supported models for a session", async () => {
    const { sessionId } = await session.create();

    const models = await session.getSupportedModels(sessionId);

    expect(models).toEqual([
      {
        value: "claude-sonnet-4-5",
        displayName: "Sonnet 4.5",
        description: "Fast and capable",
      },
      {
        value: "claude-opus-4-5",
        displayName: "Opus 4.5",
        description: "Most powerful",
      },
    ]);
    expect(mockQueryInstance.supportedModels).toHaveBeenCalledTimes(1);
  });

  it("should fetch MCP servers for a session", async () => {
    const { sessionId } = await session.create();

    const servers = await session.getMcpServers(sessionId);

    expect(servers).toEqual([
      {
        name: "filesystem",
        status: "connected",
        serverInfo: { name: "filesystem", version: "1.0.0" },
      },
      {
        name: "git",
        status: "connected",
        serverInfo: { name: "git", version: "1.0.0" },
      },
    ]);
    expect(mockQueryInstance.mcpServerStatus).toHaveBeenCalledTimes(1);
  });

  it("should handle empty results from Query methods", async () => {
    mockQueryInstance.supportedCommands.mockResolvedValue([]);
    mockQueryInstance.supportedModels.mockResolvedValue([]);
    mockQueryInstance.mcpServerStatus.mockResolvedValue([]);

    const { sessionId } = await session.create();

    const commands = await session.getSupportedCommands(sessionId);
    const models = await session.getSupportedModels(sessionId);
    const servers = await session.getMcpServers(sessionId);

    expect(commands).toEqual([]);
    expect(models).toEqual([]);
    expect(servers).toEqual([]);
  });

  it("should store session state with Query instance", async () => {
    const { sessionId } = await session.create();

    const storedSession = session.get(sessionId);
    expect(storedSession).toBeDefined();
    expect(storedSession.query).toBe(mockQueryInstance);
  });

  it("should handle Query method errors gracefully", async () => {
    mockQueryInstance.supportedCommands.mockRejectedValue(new Error("API Error"));

    const { sessionId } = await session.create();

    await expect(session.getSupportedCommands(sessionId)).rejects.toThrow("API Error");
  });

  it("should throw error for non-existent session", async () => {
    await expect(session.getSupportedCommands("non-existent-id")).rejects.toThrow(
      "session not found",
    );
    await expect(session.getSupportedModels("non-existent-id")).rejects.toThrow(
      "session not found",
    );
    await expect(session.getMcpServers("non-existent-id")).rejects.toThrow("session not found");
  });

  it("should return type-safe data from getter methods", async () => {
    const { sessionId } = await session.create();

    // Type assertions to ensure the result matches the expected interface
    expect(typeof sessionId).toBe("string");

    const commands = await session.getSupportedCommands(sessionId);
    const models = await session.getSupportedModels(sessionId);
    const servers = await session.getMcpServers(sessionId);

    expect(Array.isArray(commands)).toBe(true);
    expect(Array.isArray(models)).toBe(true);
    expect(Array.isArray(servers)).toBe(true);

    // Verify the types of array elements
    commands.forEach((cmd) => {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.argumentHint).toBe("string");
    });
    models.forEach((model) => {
      expect(typeof model.value).toBe("string");
      expect(typeof model.displayName).toBe("string");
      expect(typeof model.description).toBe("string");
    });
    servers.forEach((server) => {
      expect(typeof server.name).toBe("string");
      expect(["connected", "failed", "needs-auth", "pending"]).toContain(server.status);
    });
  });
});

describe("Session resume", () => {
  const MESSAGE = { role: "user", content: "hi" } as sdk.SDKUserMessage["message"];

  /** A query that ends immediately, so prompt() runs its resume path then returns. */
  function fakeQuery() {
    const q = {
      next: vi.fn<() => Promise<{ done: true; value: undefined }>>(async () => ({
        done: true as const,
        value: undefined,
      })),
      interrupt: vi.fn<() => void>(),
      [Symbol.asyncIterator]() {
        return q;
      },
    };
    return q;
  }

  function lastOptions(): sdk.Options {
    return (mockQuery.mock.calls.at(-1) as unknown as [{ options: sdk.Options }])[0].options;
  }

  beforeEach(() => {
    // resolveClaudeExecutable() would otherwise probe the filesystem for `claude`.
    process.env["VIBEST_CLAUDE_EXECUTABLE"] = "/fake/claude";
    mockQuery.mockReset().mockImplementation(() => fakeQuery());
    mockGetSessionInfo.mockReset();
  });

  it("pins our id as the SDK session id on create, without resuming", async () => {
    const { sessionId } = await new Session().create();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastOptions().sessionId).toBe(sessionId);
    expect(lastOptions().resume).toBeUndefined();
  });

  it("resumes a missing session from a saved transcript on the next prompt", async () => {
    mockGetSessionInfo.mockResolvedValue({ sessionId: "present" });
    const sessionId = "019f6013-0000-7000-8000-000000000000";

    const gen = new Session().prompt({ sessionId, message: MESSAGE });
    await gen.next();

    expect(mockGetSessionInfo).toHaveBeenCalledWith(sessionId);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // `resume` is passed alone — the SDK rejects it together with `sessionId`.
    expect(lastOptions().resume).toBe(sessionId);
    expect(lastOptions().sessionId).toBeUndefined();
  });

  it("throws SessionNotResumableError when nothing was saved to resume", async () => {
    mockGetSessionInfo.mockResolvedValue(undefined);
    const sessionId = "019f6013-0000-7000-8000-000000000001";

    const gen = new Session().prompt({ sessionId, message: MESSAGE });

    await expect(gen.next()).rejects.toBeInstanceOf(SessionNotResumableError);
    expect(mockQuery).not.toHaveBeenCalled(); // never spun up a blank session
  });

  it("reuses the in-memory session and never probes disk when it is present", async () => {
    const session = new Session();
    const { sessionId } = await session.create();
    mockQuery.mockClear();
    mockGetSessionInfo.mockClear();

    const gen = session.prompt({ sessionId, message: MESSAGE });
    await gen.next();

    expect(mockGetSessionInfo).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled(); // reused the existing live query
  });

  it("resumes only once when concurrent callers race for a missing session", async () => {
    mockGetSessionInfo.mockResolvedValue({ sessionId: "present" });
    const session = new Session();
    const sessionId = "019f6013-0000-7000-8000-000000000002";

    // A prompt and the permission subscription both materialize the session at once.
    const [a, b] = await Promise.all([session.ensure(sessionId), session.ensure(sessionId)]);

    expect(a).toBe(b); // same SessionState, not two clobbering rebuilds
    expect(mockGetSessionInfo).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
