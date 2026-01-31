import type * as sdk from "@anthropic-ai/claude-agent-sdk";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuid } from "uuid";

import type { ToolPermissionRequest } from "./types";

import { Pushable } from "./utils/pushable";

interface SessionState {
  /**
   * the claude code session, will set when first system message is received
   */
  id?: string;
  query: sdk.Query;
  input: Pushable<sdk.SDKUserMessage>;
  requestPermission: Pushable<ToolPermissionRequest>;
  pendingPermissionRequests: Map<string, PendingToolPermission>;
}

type PendingToolPermission = (result: sdk.PermissionResult) => void;

export class Session {
  private store = new Map<string, SessionState>();

  get(id: string) {
    const session = this.store.get(id);
    if (!session) {
      throw new Error("session not found");
    }
    return session;
  }

  list() {
    return Array.from(this.store.values());
  }

  async create(): Promise<{
    sessionId: string;
  }> {
    const input = new Pushable<sdk.SDKUserMessage>();
    const requestPermission = new Pushable<ToolPermissionRequest>();
    const sessionId = uuid();

    const options: sdk.Options = {
      mcpServers: {},
      strictMcpConfig: true,
      permissionMode: "default",
      stderr: (err) => console.error(err),
      // note: although not documented by the types, passing an absolute path
      executable: process.execPath as "node",
      // Maintain Claude Code behavior with preset system prompt
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Load filesystem settings for project-level configuration
      settingSources: ["user", "project", "local"],
      // canUseTool callback: push permission requests to output stream
      canUseTool: async (toolName, input, { signal, suggestions }) => {
        const requestId = uuid();
        const session = this.get(sessionId);
        const pendingPermissionRequests = session.pendingPermissionRequests;
        let resolve: (result: sdk.PermissionResult) => void;
        const promise = new Promise<sdk.PermissionResult>((_resolve) => {
          resolve = _resolve;
        });

        const pendingPermission: PendingToolPermission = (result: sdk.PermissionResult) => {
          resolve(result);
          cleanUp();
        };

        function cleanUp() {
          pendingPermissionRequests.delete(requestId);
          signal.removeEventListener("abort", abortHandler);
        }

        function abortHandler() {
          resolve({
            behavior: "deny",
            message: `Tool permission for ${toolName} was aborted`,
            interrupt: true,
          });
          cleanUp();
        }

        signal.addEventListener("abort", abortHandler, { once: true });

        pendingPermissionRequests.set(requestId, pendingPermission);
        // Push permission request to output stream (only necessary fields)
        requestPermission.push({
          type: "tool-permission-request",
          sessionId,
          requestId,
          toolName,
          input,
          suggestions,
        });

        return promise;
      },
    };

    const q = query({
      prompt: input,
      options,
    });

    this.store.set(sessionId, {
      query: q,
      input,
      requestPermission,
      pendingPermissionRequests: new Map(),
    });

    return {
      sessionId,
    };
  }

  async getSupportedCommands(sessionId: string): Promise<sdk.SlashCommand[]> {
    const session = this.get(sessionId);
    return session.query.supportedCommands();
  }

  async getSupportedModels(sessionId: string): Promise<sdk.ModelInfo[]> {
    const session = this.get(sessionId);
    return session.query.supportedModels();
  }

  async getMcpServers(sessionId: string): Promise<sdk.McpServerStatus[]> {
    const session = this.get(sessionId);
    return session.query.mcpServerStatus();
  }

  abort(sessionId: string) {
    const session = this.get(sessionId);

    for (const resolve of session.pendingPermissionRequests.values()) {
      resolve({
        behavior: "deny",
        message: "Request aborted due to session termination",
        interrupt: true,
      });
    }
    session.requestPermission.end();
    session.pendingPermissionRequests.clear();

    session.input.end();
    session.query.interrupt();

    this.store.delete(sessionId);
  }

  interrupt(sessionId: string) {
    const session = this.get(sessionId);
    session.query.interrupt();
  }

  async *prompt(input: {
    sessionId: string;
    message: sdk.SDKUserMessage["message"];
  }): AsyncGenerator<sdk.SDKMessage, void, unknown> {
    const session = this.get(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} not found`);
    }
    session.input.push({
      type: "user",
      message: input.message,
      parent_tool_use_id: null,
      session_id: input.sessionId,
    });

    while (true) {
      const { value: message, done } = await session.query.next();

      if (done || !message) {
        return;
      }
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            session.id = message.session_id;
          }
          yield message;
          break;
        }
        case "result": {
          yield message;
          return;
        }
        default: {
          yield message;
          break;
        }
      }
    }
  }

  respondPermission(sessionId: string, requestId: string, result: sdk.PermissionResult) {
    const session = this.get(sessionId);
    const request = session.pendingPermissionRequests.get(requestId);
    if (!request) {
      throw new Error(`Pending tool permission request ${requestId} not found`);
    }
    request(result);
    return true;
  }
}

export class ClaudeCodeAgent {
  session = new Session();
}
