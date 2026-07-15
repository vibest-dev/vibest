import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuid } from "uuid";

import { Pushable } from "../utils/pushable";
import { resolveClaudeExecutable } from "./executable";

/**
 * Thrown when a prompt arrives for a session the server no longer holds in
 * memory (it restarted) and Claude has no saved transcript to resume from — the
 * history was cleared, or nothing was ever persisted. Surfaced to the renderer
 * so it can tell the user the conversation cannot be restored, rather than
 * silently starting a blank session under the same id.
 */
export class SessionNotResumableError extends Error {
  readonly code = "SESSION_NOT_RESUMABLE";

  constructor(sessionId: string) {
    super(
      `Session ${sessionId} could not be resumed: no saved history was found. ` +
        `It may have been cleared, or the working directory changed.`,
    );
    this.name = "SessionNotResumableError";
  }
}

// Emitted while a prompt is running; the client answers via
// `respondPermission`. The contract re-exports this type for both sides.
export type ToolPermissionRequest = {
  type: "tool-permission-request";
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: sdk.PermissionUpdate[];
};

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
  // In-flight resumes, keyed by session id, so concurrent callers (a prompt and
  // the permission subscription racing after a backend restart) share one
  // resume instead of each spawning a query and clobbering the store.
  private resuming = new Map<string, Promise<SessionState>>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(id: string) {
    const session = this.store.get(id);
    if (!session) {
      throw new Error("session not found");
    }
    return session;
  }

  /**
   * Return the live session for `id`, resuming it from Claude's saved transcript
   * if the server no longer holds it in memory (it restarted). Throws
   * {@link SessionNotResumableError} when nothing was saved. This is the entry
   * point every request that needs a live session should use, so a restarted
   * backend recovers transparently instead of throwing "session not found".
   */
  async ensure(id: string): Promise<SessionState> {
    const existing = this.store.get(id);
    if (existing) return existing;

    let inFlight = this.resuming.get(id);
    if (!inFlight) {
      inFlight = this.resume(id).finally(() => this.resuming.delete(id));
      this.resuming.set(id, inFlight);
    }
    return inFlight;
  }

  list() {
    return Array.from(this.store.values());
  }

  async create(): Promise<{
    sessionId: string;
  }> {
    const sessionId = uuid();
    // Pin our id as Claude's session id (a valid UUID), so the transcript
    // persists under it and can be resumed after a backend restart.
    this.buildSession(sessionId, { sessionId });
    return { sessionId };
  }

  /**
   * Spin up a live query for `sessionId` and store it. `extra` carries the
   * session-identity options: `{ sessionId }` for a fresh session, or
   * `{ resume }` to reload one from disk.
   */
  private buildSession(sessionId: string, extra: Partial<sdk.Options>): SessionState {
    const input = new Pushable<sdk.SDKUserMessage>();
    const requestPermission = new Pushable<ToolPermissionRequest>();

    const options: sdk.Options = {
      mcpServers: {},
      strictMcpConfig: true,
      permissionMode: "default",
      stderr: (err) => console.error(err),
      // note: although not documented by the types, passing an absolute path
      executable: process.execPath as "node",
      // Resolved rather than left to the SDK: its own resolution silently
      // points into app.asar in a packaged build, which cannot be exec'd.
      pathToClaudeCodeExecutable: resolveClaudeExecutable({ env: this.env }),
      // Pass the server environment explicitly so GUI-launched desktop apps
      // preserve proxy and authentication variables in the Claude subprocess.
      env: { ...this.env },
      // Maintain Claude Code behavior with preset system prompt
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Load filesystem settings for project-level configuration
      settingSources: ["user", "project", "local"],
      // canUseTool callback: push permission requests to output stream
      canUseTool: async (toolName, toolInput, { signal, suggestions }) => {
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
          input: toolInput,
          suggestions,
        });

        return promise;
      },
      ...extra,
    };

    const q = query({ prompt: input, options });
    const state: SessionState = {
      query: q,
      input,
      requestPermission,
      pendingPermissionRequests: new Map(),
    };
    this.store.set(sessionId, state);
    return state;
  }

  /**
   * Rebuild a session the server no longer holds in memory (it restarted) by
   * resuming Claude's persisted transcript. Throws {@link SessionNotResumableError}
   * when nothing was saved, so a lost history never masquerades as a live blank
   * session. `resume` is passed alone — the SDK rejects `sessionId` alongside it.
   */
  private async resume(sessionId: string): Promise<SessionState> {
    const info = await getSessionInfo(sessionId);
    if (!info) {
      throw new SessionNotResumableError(sessionId);
    }
    return this.buildSession(sessionId, { resume: sessionId });
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
    // A missing session means the backend restarted since it was created; ensure
    // resumes it from Claude's saved transcript rather than failing (or, if
    // nothing was saved, throws SessionNotResumableError for the renderer).
    const session = await this.ensure(input.sessionId);
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
