import * as os from "node:os";
import * as pty from "node-pty";

import type { IPty } from "node-pty";

import type { TerminalEvent } from "../../shared/contract/terminal";

export interface TerminalInstance {
	id: string;
	worktreeId: string;
	pty: IPty;
	title: string;
	subscribers: Set<(event: TerminalEvent) => void>;
}

export class TerminalManager {
	private terminals: Map<string, TerminalInstance> = new Map();
	private counter = 0;

	create(worktreeId: string, cwd: string): TerminalInstance {
		const id = `terminal-${++this.counter}`;
		const shell = os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "bash";

		const ptyProcess = pty.spawn(shell, [], {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
		});

		const instance: TerminalInstance = {
			id,
			worktreeId,
			pty: ptyProcess,
			title: this.generateTitle(worktreeId),
			subscribers: new Set(),
		};

		ptyProcess.onData((data) => {
			this.emit(id, { type: "data", data });
		});

		ptyProcess.onExit(({ exitCode }) => {
			this.emit(id, { type: "exit", exitCode });
			this.terminals.delete(id);
		});

		this.terminals.set(id, instance);
		return instance;
	}

	subscribe(terminalId: string, callback: (event: TerminalEvent) => void): () => void {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			// Terminal doesn't exist, return no-op unsubscribe
			return () => {};
		}

		instance.subscribers.add(callback);

		// Return unsubscribe function
		return () => {
			instance.subscribers.delete(callback);
		};
	}

	private emit(terminalId: string, event: TerminalEvent): void {
		const instance = this.terminals.get(terminalId);
		if (instance) {
			for (const callback of instance.subscribers) {
				callback(event);
			}
		}
	}

	write(terminalId: string, data: string): void {
		const instance = this.terminals.get(terminalId);
		if (instance) {
			instance.pty.write(data);
		}
	}

	resize(terminalId: string, cols: number, rows: number): void {
		const instance = this.terminals.get(terminalId);
		if (instance) {
			instance.pty.resize(cols, rows);
		}
	}

	close(terminalId: string): void {
		const instance = this.terminals.get(terminalId);
		if (instance) {
			instance.pty.kill();
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
			instance.pty.kill();
		}
		this.terminals.clear();
	}

	private generateTitle(worktreeId: string): string {
		const count = this.getTerminalsByWorktree(worktreeId).length;
		return count === 0 ? "Terminal" : `Terminal ${count + 1}`;
	}

	/** Recalculate titles after a terminal is closed */
	recalculateTitles(worktreeId: string): void {
		const terminals = this.getTerminalsByWorktree(worktreeId);
		if (terminals.length === 1) {
			terminals[0].title = "Terminal";
		} else {
			terminals.forEach((t, i) => {
				t.title = `Terminal ${i + 1}`;
			});
		}
	}
}
