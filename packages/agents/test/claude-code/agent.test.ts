import { beforeEach, describe, expect, it, vi } from "vitest";

import { Session } from "../../src/claude-code/agent";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
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
      supportedCommands: vi.fn().mockResolvedValue([
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
      supportedModels: vi.fn().mockResolvedValue([
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
      mcpServerStatus: vi.fn().mockResolvedValue([
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
      accountInfo: vi.fn().mockResolvedValue({ plan: "pro" }),
      interrupt: vi.fn(),
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
