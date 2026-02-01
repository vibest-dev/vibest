import type { IPty } from "node-pty";

import * as pty from "node-pty";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { AppPublisher } from "../app";

/** Batch duration in ms (same as Hyper) */
const BATCH_DURATION_MS = 16;

/**
 * Max size of a session data batch. Note that this value can be exceeded by ~4k
 * (chunk sizes seem to be 4k at the most)
 */
const BATCH_MAX_SIZE = 200 * 1024;

/**
 * Data coming from the pty is sent to the renderer process for further
 * vt parsing and rendering. This class batches data to minimize the number of
 * IPC calls. It also reduces GC pressure and CPU cost.
 *
 * Based on Hyper's DataBatcher implementation.
 */
class DataBatcher {
  private decoder = new StringDecoder("utf8");
  private data = "";
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly terminalId: string,
    private readonly publisher: AppPublisher,
  ) {}

  write(chunk: Buffer | string): void {
    if (this.data.length + chunk.length >= BATCH_MAX_SIZE) {
      // We've reached the max batch size. Flush it and start another one
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      this.flush();
    }

    this.data += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    if (!this.timeout) {
      this.timeout = setTimeout(() => this.flush(), BATCH_DURATION_MS);
    }
  }

  flush(): void {
    // Reset before publishing to allow for potential reentrancy
    const data = this.data;
    this.data = "";
    this.timeout = null;

    if (data.length > 0) {
      this.publisher.publish(`terminal:${this.terminalId}`, { type: "data", data });
    }
  }

  dispose(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.data = "";
  }
}

export interface TerminalInstance {
  id: string;
  worktreeId: string;
  pty: IPty;
  batcher: DataBatcher;
  ended: boolean;
}

export class TerminalManager {
  private static readonly MAX_TERMINALS_PER_WORKTREE = 10;
  private static readonly MAX_TERMINALS_GLOBAL = 50;

  private terminals: Map<string, TerminalInstance> = new Map();

  constructor(private readonly publisher: AppPublisher) {}

  create(worktreeId: string, cwd: string): TerminalInstance {
    // Check global terminal limit
    if (this.terminals.size >= TerminalManager.MAX_TERMINALS_GLOBAL) {
      throw new Error(`Maximum terminal limit reached (${TerminalManager.MAX_TERMINALS_GLOBAL})`);
    }

    // Check per-worktree terminal limit
    const worktreeTerminals = this.getTerminalsByWorktree(worktreeId);
    if (worktreeTerminals.length >= TerminalManager.MAX_TERMINALS_PER_WORKTREE) {
      throw new Error(
        `Maximum terminals per worktree reached (${TerminalManager.MAX_TERMINALS_PER_WORKTREE})`,
      );
    }

    if (!fs.existsSync(cwd)) {
      throw new Error(`Directory does not exist: ${cwd}`);
    }

    const id = crypto.randomUUID();
    const shell = process.env.SHELL || "bash";

    // Don't pass cols/rows here - let node-pty use defaults.
    // The correct size will be set by xterm after mount via resize().
    // See: https://github.com/vercel/hyper/blob/canary/app/ui/window.ts#L161
    const ptyProcess = pty.spawn(shell, ["--login"], {
      name: "xterm-256color",
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    const batcher = new DataBatcher(id, this.publisher);

    const instance: TerminalInstance = {
      id,
      worktreeId,
      pty: ptyProcess,
      batcher,
      ended: false,
    };

    // PTY data → batcher → publisher
    ptyProcess.onData((chunk) => {
      if (instance.ended) {
        return;
      }
      batcher.write(chunk);
    });

    // PTY exit → publish
    ptyProcess.onExit(({ exitCode }) => {
      if (!instance.ended) {
        instance.ended = true;
        this.publisher.publish(`terminal:${id}`, { type: "exit", exitCode });
        this.terminals.delete(id);
      }
    });

    this.terminals.set(id, instance);
    return instance;
  }

  write(terminalId: string, data: string): void {
    const instance = this.terminals.get(terminalId);
    if (instance && !instance.ended) {
      instance.pty.write(data);
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      try {
        instance.pty.resize(cols, rows);
      } catch (err) {
        console.error("[TerminalManager] Resize error:", err);
      }
    }
  }

  close(terminalId: string): void {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      instance.batcher.dispose();
      try {
        instance.pty.kill();
      } catch (err) {
        console.error("[TerminalManager] Kill error:", err);
      }
      instance.ended = true;
      this.terminals.delete(terminalId);
    }
  }

  getTerminalsByWorktree(worktreeId: string): TerminalInstance[] {
    return Array.from(this.terminals.values()).filter((t) => t.worktreeId === worktreeId);
  }

  get(terminalId: string): TerminalInstance | undefined {
    return this.terminals.get(terminalId);
  }

  dispose(): void {
    for (const instance of this.terminals.values()) {
      instance.batcher.dispose();
      try {
        instance.pty.kill();
      } catch (err) {
        console.error("[TerminalManager] Kill error:", err);
      }
    }
    this.terminals.clear();
  }

  /** Subscribe to terminal events */
  subscribe(terminalId: string, options: { signal: AbortSignal }) {
    return this.publisher.subscribe(`terminal:${terminalId}`, options);
  }
}
