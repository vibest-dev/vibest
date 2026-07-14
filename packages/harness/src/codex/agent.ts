import type { AgentRequest, AgentResponse } from "../types/request";
import { Pushable } from "../utils/pushable";
import { CodexAppServer } from "./app-server";
import type { ServerNotification, ServerRequest } from "./protocol";
import type {
  ThreadStartResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "./protocol/v2";
import {
  approvalSourceOf,
  buildApprovalRequest,
  buildUserInputRequest,
  declineResult,
  emptyUserInputResponse,
  isApprovalRequest,
  isUserInputRequest,
  mapApprovalResponse,
  mapUserInputResponse,
} from "./request";
import { createCodexTransform } from "./transform";
import type { CodexUIMessageChunk } from "./ui-message";

// clientInfo.name identifies the integration to OpenAI's Compliance Logs — a
// stable identifier, never a per-run value.
const CLIENT_INFO = { name: "vibest", title: "Vibest", version: "0.0.0" };

interface SessionState {
  threadId: string;
  chunks: Pushable<CodexUIMessageChunk>;
  // One durable reader; `prompt()` pulls from it so breaking out of a turn's
  // loop never closes the underlying stream (for-await would call return()).
  reader: AsyncIterator<CodexUIMessageChunk>;
  requests: Pushable<AgentRequest>;
  pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      declineValue: unknown;
      settle: (r: AgentResponse) => unknown;
    }
  >;
  transform: ReturnType<typeof createCodexTransform>;
  activeTurnId?: string;
}

export class Session {
  private store = new Map<string, SessionState>();
  private server: CodexAppServer | undefined;
  private starting: Promise<CodexAppServer> | undefined;
  private readonly executablePath?: string;

  constructor(options?: { executablePath?: string }) {
    this.executablePath = options?.executablePath;
  }

  get(id: string): SessionState {
    const session = this.store.get(id);
    if (!session) throw new Error("session not found");
    return session;
  }

  async create(config: { workspacePath: string }): Promise<{ sessionId: string }> {
    const server = await this.ensureServer();
    const response = await server.request<ThreadStartResponse>("thread/start", {
      cwd: config.workspacePath,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const chunks = new Pushable<CodexUIMessageChunk>();
    const state: SessionState = {
      threadId: response.thread.id,
      chunks,
      reader: chunks[Symbol.asyncIterator](),
      requests: new Pushable<AgentRequest>(),
      pending: new Map(),
      transform: createCodexTransform(),
    };
    this.store.set(state.threadId, state);
    return { sessionId: state.threadId };
  }

  async *prompt(input: { sessionId: string; text: string }): AsyncGenerator<CodexUIMessageChunk> {
    const session = this.get(input.sessionId);
    const server = await this.ensureServer();
    const turnInput: UserInput[] = [{ type: "text", text: input.text, text_elements: [] }];
    // Mid-turn input steers the active turn; a rejected precondition means the
    // turn is gone — fall through to turn/start (protocol race guard).
    if (session.activeTurnId) {
      try {
        await server.request<TurnSteerResponse>("turn/steer", {
          threadId: session.threadId,
          input: turnInput,
          expectedTurnId: session.activeTurnId,
        });
        return;
      } catch {
        session.activeTurnId = undefined;
      }
    }
    const response = await server.request<TurnStartResponse>("turn/start", {
      threadId: session.threadId,
      input: turnInput,
    });
    session.activeTurnId = response.turn.id;
    while (true) {
      const { value, done } = await session.reader.next();
      if (done || !value) return;
      yield value;
      if (value.type === "finish") {
        session.activeTurnId = undefined;
        return;
      }
    }
  }

  requestPermission(sessionId: string): Pushable<AgentRequest> {
    return this.get(sessionId).requests;
  }

  respondPermission(sessionId: string, requestId: string, response: AgentResponse): boolean {
    const session = this.get(sessionId);
    const pending = session.pending.get(requestId);
    if (!pending) throw new Error(`Pending agent request ${requestId} not found`);
    session.pending.delete(requestId);
    pending.resolve(pending.settle(response));
    return true;
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session.activeTurnId || !this.server) return;
    await this.server
      .request("turn/interrupt", { threadId: session.threadId, turnId: session.activeTurnId })
      .catch(() => {});
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    for (const pending of session.pending.values()) pending.resolve(pending.declineValue);
    session.pending.clear();
    session.requests.end();
    await this.interrupt(sessionId);
    await this.server
      ?.request("thread/unsubscribe", { threadId: session.threadId })
      .catch(() => {});
    session.chunks.end();
    this.store.delete(sessionId);
  }

  private ensureServer(): Promise<CodexAppServer> {
    if (this.server) return Promise.resolve(this.server);
    this.starting ??= this.startServer();
    return this.starting;
  }

  private async startServer(): Promise<CodexAppServer> {
    const server = new CodexAppServer({
      executablePath: this.executablePath,
      handlers: {
        onNotification: (notification) => this.routeNotification(notification),
        onServerRequest: (request) => this.handleServerRequest(request),
        onExit: () => this.handleServerExit(),
      },
    });
    server.start();
    try {
      await server.initialize(CLIENT_INFO);
    } catch (error) {
      this.starting = undefined;
      await server.close();
      throw error;
    }
    this.server = server;
    this.starting = undefined;
    return server;
  }

  private routeNotification(notification: ServerNotification): void {
    const params = notification.params as { threadId?: string } | undefined;
    if (!params?.threadId) return;
    const session = this.store.get(params.threadId);
    if (!session) return;
    for (const chunk of session.transform(notification)) session.chunks.push(chunk);
  }

  private handleServerRequest(request: ServerRequest): Promise<unknown> {
    if (isApprovalRequest(request)) {
      const session = this.store.get(request.params.threadId);
      const source = approvalSourceOf(request.method);
      if (!session) return Promise.resolve(declineResult(source));
      const agentRequest = buildApprovalRequest(request);
      return new Promise((resolve) => {
        session.pending.set(agentRequest.id, {
          resolve,
          settle: (r) => mapApprovalResponse(r, source),
          declineValue: declineResult(source),
        });
        session.requests.push(agentRequest);
      });
    }
    if (isUserInputRequest(request)) {
      const session = this.store.get(request.params.threadId);
      if (!session) return Promise.resolve(emptyUserInputResponse());
      const agentRequest = buildUserInputRequest(request);
      return new Promise((resolve) => {
        session.pending.set(agentRequest.id, {
          resolve,
          settle: (r) => mapUserInputResponse(r),
          declineValue: emptyUserInputResponse(),
        });
        session.requests.push(agentRequest);
      });
    }
    return Promise.reject(new Error(`Unhandled codex server request: ${request.method}`));
  }

  private handleServerExit(): void {
    this.server = undefined;
    this.starting = undefined;
    for (const session of this.store.values()) {
      for (const pending of session.pending.values()) pending.resolve(pending.declineValue);
      session.pending.clear();
      session.requests.end();
      // Tell any mid-turn consumer why the stream is ending — without this, a
      // crash is indistinguishable from a benign disconnect.
      session.chunks.push({ type: "error", errorText: "codex app-server exited unexpectedly" });
      session.chunks.end();
    }
    this.store.clear();
  }
}

export class CodexAgent {
  session: Session;
  constructor(options?: { executablePath?: string }) {
    this.session = new Session(options);
  }
}
