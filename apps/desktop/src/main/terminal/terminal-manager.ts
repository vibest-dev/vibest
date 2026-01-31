import * as os from "node:os";
import * as pty from "node-pty";

import type { IPty } from "node-pty";

export interface TerminalInstance {
	id: string;
	worktreeId: string;
	pty: IPty;
	title: string;
}

export type TerminalEventHandler = {
	onData: (terminalId: string, data: string) => void;
	onExit: (terminalId: string, exitCode: number) => void;
};

export class TerminalManager {
	private terminals: Map<string, TerminalInstance> = new Map();
	private counter = 0;
	private eventHandler: TerminalEventHandler | null = null;

	setEventHandler(handler: TerminalEventHandler): void {
		this.eventHandler = handler;
	}

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
		};

		ptyProcess.onData((data) => {
			this.eventHandler?.onData(id, data);
		});

		ptyProcess.onExit(({ exitCode }) => {
			this.terminals.delete(id);
			this.eventHandler?.onExit(id, exitCode);
		});

		this.terminals.set(id, instance);
		return instance;
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
