import type { IPty } from "node-pty";

import * as pty from "node-pty";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { Publisher } from "../publisher";
import type { TerminalSnapshot } from "./types";

import { HeadlessTerminal } from "./headless-terminal";

export type TerminalDataEvent = {
  type: "data";
  data: string;
};

export type TerminalExitEvent = {
  type: "exit";
  exitCode: number;
};

export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

export type TerminalEvents = {
  [K: `terminal:${string}`]: TerminalEvent;
};

/**
 * Direct publisher without batching.
 */
class DirectPublisher {
  private decoder = new StringDecoder("utf8");

  constructor(
    private readonly terminalId: string,
    private readonly publisher: Publisher<TerminalEvents>,
  ) {}

  write(chunk: Buffer | string): void {
    const data = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (data.length > 0) {
      this.publisher.publish(`terminal:${this.terminalId}`, { type: "data", data });
    }
  }

  dispose(): void {
    // Nothing to clean up
  }
}

export interface TerminalInstance {
  id: string;
  worktreeId: string;
  pty: IPty;
  publisher: DirectPublisher;
  headless: HeadlessTerminal;
  ended: boolean;
}

export class TerminalManager {
  private static readonly MAX_TERMINALS_PER_WORKTREE = 10;
  private static readonly MAX_TERMINALS_GLOBAL = 50;

  private terminals: Map<string, TerminalInstance> = new Map();

  constructor(private readonly publisher: Publisher<TerminalEvents>) {}

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

    const directPublisher = new DirectPublisher(id, this.publisher);

    // Create headless terminal for state persistence
    const headless = new HeadlessTerminal({ scrollback: 10000 });
    headless.setCwd(cwd);

    const instance: TerminalInstance = {
      id,
      worktreeId,
      pty: ptyProcess,
      publisher: directPublisher,
      headless,
      ended: false,
    };

    // PTY data → headless (for state) + publisher (for streaming)
    ptyProcess.onData((chunk) => {
      if (instance.ended) {
        return;
      }
      headless.write(chunk);
      directPublisher.write(chunk);
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
        instance.headless.resize(cols, rows);
      } catch (err) {
        console.error("[TerminalManager] Resize error:", err);
      }
    }
  }

  close(terminalId: string): void {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      instance.publisher.dispose();
      instance.headless.dispose();
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

  async getSnapshot(terminalId: string): Promise<TerminalSnapshot | null> {
    const instance = this.terminals.get(terminalId);
    if (!instance) {
      return null;
    }

    return instance.headless.getSnapshotAsync();
  }

  dispose(): void {
    for (const instance of this.terminals.values()) {
      instance.publisher.dispose();
      instance.headless.dispose();
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
