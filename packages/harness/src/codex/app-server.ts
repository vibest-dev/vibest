import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from "./protocol";

// A minimal JSON-RPC 2.0 client for `codex app-server` over stdio.
//
// Wire facts (codex app-server, verified against codex-cli 0.137.0):
//   • newline-delimited JSON (JSONL); the `"jsonrpc":"2.0"` header is OMITTED.
//   • response   → `{ id, result }` or `{ id, error: { code, message } }` (no `method`).
//   • notification (server→client, no reply) → `{ method, params }` (no `id`).
//   • server request (server→client, expects reply) → `{ method, id, params }`.
//
// Payload types come from the generated, version-matched protocol bindings in
// `./protocol` (`codex app-server generate-ts`): inbound frames are surfaced as the
// `ServerNotification` / `ServerRequest` discriminated unions so callers narrow on
// `.method`. Phase 0 owns transport + correlation + the `initialize` handshake only.

export interface CodexAppServerHandlers {
  /** Server→client notification — no reply expected. Narrow on `notification.method`. */
  onNotification?: (notification: ServerNotification) => void;
  /** Server→client request — resolve with the matching response, or reject to send an error. */
  onServerRequest?: (request: ServerRequest) => Promise<unknown>;
  /** The child exited or failed to spawn outside of an explicit `close()`. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface CodexAppServerOptions {
  executablePath?: string;
  cwd?: string;
  /** Extra args appended after `app-server` (e.g. `-c key=value`). */
  args?: string[];
  handlers?: CodexAppServerHandlers;
}

/** A `{ error: { code, message } }` frame returned for one of our requests. */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class CodexAppServer {
  private readonly executablePath: string;
  private readonly cwd?: string;
  private readonly args: string[];
  private readonly handlers: CodexAppServerHandlers;

  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private stderrTail = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  // Zombie net: a synchronous SIGKILL registered on daemon `exit`, so a hard
  // shutdown path that skips close() (process.exit elsewhere, fatal error) still
  // cannot strand the child. Removed once the child is gone.
  private killOnExit: (() => void) | undefined;

  constructor(options: CodexAppServerOptions) {
    this.executablePath = options.executablePath ?? "codex";
    this.cwd = options.cwd;
    this.args = options.args ?? [];
    this.handlers = options.handlers ?? {};
  }

  /** Spawn `codex app-server` and start consuming its JSONL stream. */
  start(): void {
    if (this.child) throw new Error("CodexAppServer already started");
    const child = spawn(this.executablePath, ["app-server", ...this.args], { cwd: this.cwd });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    // Drain stderr to avoid pipe backpressure; keep a short tail for crash diagnostics.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
    child.on("error", (error) => this.onSpawnError(error));
    this.killOnExit = () => child.kill("SIGKILL");
    process.once("exit", this.killOnExit);
  }

  private clearKillOnExit(): void {
    if (!this.killOnExit) return;
    process.removeListener("exit", this.killOnExit);
    this.killOnExit = undefined;
  }

  /** Run the `initialize` handshake, then emit the `initialized` notification. */
  async initialize(
    clientInfo: ClientInfo,
    capabilities?: InitializeCapabilities,
  ): Promise<InitializeResponse> {
    const params: InitializeParams = { clientInfo, capabilities: capabilities ?? null };
    const result = await this.request<InitializeResponse>("initialize", params);
    this.notify("initialized");
    return result;
  }

  /** Send a request and resolve with its `result` (or reject with a CodexRpcError). */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error("CodexAppServer not started"));
    if (this.closed) return Promise.reject(new Error("CodexAppServer closed"));
    const id = this.nextId++;
    const frame: Record<string, unknown> = { method, id };
    if (params !== undefined) frame.params = params;
    return new Promise<T>((resolve, reject) => {
      // The caller asserts the result shape via T — a narrow boundary cast.
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.write(frame);
    });
  }

  /** Send a fire-and-forget notification (no `id`, no reply). */
  notify(method: string, params?: unknown): void {
    const frame: Record<string, unknown> = { method };
    if (params !== undefined) frame.params = params;
    this.write(frame);
  }

  /** Terminate the child and reject any in-flight requests. Idempotent. */
  async close(): Promise<void> {
    const child = this.child;
    if (this.closed || !child) {
      child?.kill();
      this.closed = true;
      return;
    }
    this.closed = true;
    this.rejectAllPending(new Error("CodexAppServer closed"));
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      child.kill();
      setTimeout(done, 1000).unref();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-JSON line on the protocol stream — ignore
    }
    if (!isRecord(message)) return;
    const hasMethod = typeof message.method === "string";
    const id = message.id;
    if (hasMethod) {
      // The app-server is a trusted, version-matched local subprocess, so the
      // parsed frame is asserted against the generated protocol union rather than
      // re-validated. A method with an `id` is a server request; without, a notification.
      if (id === undefined)
        this.handlers.onNotification?.(message as unknown as ServerNotification);
      else this.handleServerRequest(message as unknown as ServerRequest);
      return;
    }
    if (typeof id === "number") this.handleResponse(id, message);
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in message && isRecord(message.error)) {
      const error = message.error;
      const code = typeof error.code === "number" ? error.code : -32603;
      const text = typeof error.message === "string" ? error.message : "Unknown app-server error";
      pending.reject(new CodexRpcError(code, text, error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: ServerRequest): void {
    const handler = this.handlers.onServerRequest;
    const id = request.id;
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `No handler for ${request.method}` } });
      return;
    }
    void handler(request)
      .then((result) => this.write({ id, result: result ?? null }))
      .catch((error: unknown) =>
        this.write({ id, error: { code: -32603, message: errorMessage(error) } }),
      );
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearKillOnExit();
    const wasClosed = this.closed;
    this.closed = true;
    const tail = this.stderrTail.trim();
    this.rejectAllPending(
      new Error(
        `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${tail ? `: ${tail}` : ""}`,
      ),
    );
    if (!wasClosed) this.handlers.onExit?.({ code, signal });
  }

  private onSpawnError(error: Error): void {
    this.clearKillOnExit();
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAllPending(error);
    if (!wasClosed) this.handlers.onExit?.({ code: null, signal: null });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private write(frame: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
