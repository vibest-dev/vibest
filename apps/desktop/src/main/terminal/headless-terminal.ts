/**
 * Headless Terminal
 *
 * Wraps @xterm/headless with:
 * - Mode tracking (DECSET/DECRST parsing)
 * - Snapshot generation via @xterm/addon-serialize
 * - Rehydration sequence generation for mode restoration
 * - OSC-7 parsing for CWD tracking
 */

import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import {
	DEFAULT_MODES,
	type TerminalModes,
	type TerminalSnapshot,
} from "./types";

// =============================================================================
// Mode Tracking Constants
// =============================================================================

const ESC = "\x1b";
const BEL = "\x07";

/**
 * DECSET/DECRST mode numbers we track
 */
const MODE_MAP: Record<number, keyof TerminalModes> = {
	1: "applicationCursorKeys",
	6: "originMode",
	7: "autoWrap",
	9: "mouseTrackingX10",
	25: "cursorVisible",
	47: "alternateScreen", // Legacy alternate screen
	1000: "mouseTrackingNormal",
	1001: "mouseTrackingHighlight",
	1002: "mouseTrackingButtonEvent",
	1003: "mouseTrackingAnyEvent",
	1004: "focusReporting",
	1005: "mouseUtf8",
	1006: "mouseSgr",
	1049: "alternateScreen", // Modern alternate screen with save/restore
	2004: "bracketedPaste",
};

// =============================================================================
// HeadlessTerminal Class
// =============================================================================

export interface HeadlessTerminalOptions {
	cols?: number;
	rows?: number;
	scrollback?: number;
}

export class HeadlessTerminal {
	private terminal: Terminal;
	private serializeAddon: SerializeAddon;
	private modes: TerminalModes;
	private cwd: string | null = null;
	private disposed = false;

	// Buffer for partial escape sequences that span chunk boundaries
	private escapeSequenceBuffer = "";

	// Maximum buffer size to prevent unbounded growth
	private static readonly MAX_ESCAPE_BUFFER_SIZE = 1024;

	constructor(options: HeadlessTerminalOptions = {}) {
		const { cols = 80, rows = 24, scrollback = 10000 } = options;

		this.terminal = new Terminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true,
		});

		this.serializeAddon = new SerializeAddon();
		this.terminal.loadAddon(this.serializeAddon);

		// Initialize mode state
		this.modes = { ...DEFAULT_MODES };
	}

	/**
	 * Write data to the terminal emulator (synchronous, non-blocking)
	 */
	write(data: string): void {
		if (this.disposed) return;

		// Parse escape sequences with chunk-safe buffering
		this.parseEscapeSequences(data);
		// Write to headless terminal
		this.terminal.write(data);
	}

	/**
	 * Write data to the terminal emulator and wait for completion.
	 */
	async writeSync(data: string): Promise<void> {
		if (this.disposed) return;

		this.parseEscapeSequences(data);

		return new Promise<void>((resolve) => {
			this.terminal.write(data, () => resolve());
		});
	}

	/**
	 * Resize the terminal
	 */
	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		this.terminal.resize(cols, rows);
	}

	/**
	 * Get current terminal dimensions
	 */
	getDimensions(): { cols: number; rows: number } {
		return {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	/**
	 * Get current terminal modes
	 */
	getModes(): TerminalModes {
		return { ...this.modes };
	}

	/**
	 * Get current working directory (from OSC-7)
	 */
	getCwd(): string | null {
		return this.cwd;
	}

	/**
	 * Set CWD directly (for initial session setup)
	 */
	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	/**
	 * Get scrollback line count
	 */
	getScrollbackLines(): number {
		return this.terminal.buffer.active.length;
	}

	/**
	 * Flush all pending writes to the terminal.
	 */
	async flush(): Promise<void> {
		if (this.disposed) return;
		return new Promise<void>((resolve) => {
			this.terminal.write("", () => resolve());
		});
	}

	/**
	 * Generate a complete snapshot for session restore.
	 */
	getSnapshot(): TerminalSnapshot {
		const snapshotAnsi = this.serializeAddon.serialize({
			scrollback: this.terminal.options.scrollback ?? 10000,
		});

		const rehydrateSequences = this.generateRehydrateSequences();

		return {
			snapshotAnsi,
			rehydrateSequences,
			cwd: this.cwd,
			modes: { ...this.modes },
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			scrollbackLines: this.getScrollbackLines(),
		};
	}

	/**
	 * Generate a complete snapshot after flushing pending writes.
	 */
	async getSnapshotAsync(): Promise<TerminalSnapshot> {
		await this.flush();
		return this.getSnapshot();
	}

	/**
	 * Clear terminal buffer
	 */
	clear(): void {
		if (this.disposed) return;
		this.terminal.clear();
	}

	/**
	 * Reset terminal to default state
	 */
	reset(): void {
		if (this.disposed) return;
		this.terminal.reset();
		this.modes = { ...DEFAULT_MODES };
	}

	/**
	 * Dispose of the terminal
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.terminal.dispose();
	}

	// ===========================================================================
	// Private Methods
	// ===========================================================================

	/**
	 * Parse escape sequences with chunk-safe buffering.
	 */
	private parseEscapeSequences(data: string): void {
		const fullData = this.escapeSequenceBuffer + data;
		this.escapeSequenceBuffer = "";

		this.parseModeChanges(fullData);
		this.parseOsc7(fullData);

		const incompleteSequence = this.findIncompleteTrackedSequence(fullData);

		if (incompleteSequence) {
			if (
				incompleteSequence.length <= HeadlessTerminal.MAX_ESCAPE_BUFFER_SIZE
			) {
				this.escapeSequenceBuffer = incompleteSequence;
			}
		}
	}

	/**
	 * Find an incomplete DECSET/DECRST or OSC-7 sequence at the end of data.
	 */
	private findIncompleteTrackedSequence(data: string): string | null {
		const escEscaped = escapeRegex(ESC);

		const lastEscIndex = data.lastIndexOf(ESC);
		if (lastEscIndex === -1) return null;

		const afterLastEsc = data.slice(lastEscIndex);

		// Pattern: ESC[? - start of DECSET/DECRST
		if (afterLastEsc.startsWith(`${ESC}[?`)) {
			const completePattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`);
			if (completePattern.test(afterLastEsc)) {
				const globalPattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`, "g");
				const matches = afterLastEsc.match(globalPattern);
				if (matches) {
					const lastMatch = matches[matches.length - 1];
					const lastMatchEnd =
						afterLastEsc.lastIndexOf(lastMatch) + lastMatch.length;
					const remainder = afterLastEsc.slice(lastMatchEnd);
					if (remainder.includes(ESC)) {
						return this.findIncompleteTrackedSequence(remainder);
					}
				}
				return null;
			}
			return afterLastEsc;
		}

		// Pattern: ESC]7; - start of OSC-7
		if (afterLastEsc.startsWith(`${ESC}]7;`)) {
			if (afterLastEsc.includes(BEL) || afterLastEsc.includes(`${ESC}\\`)) {
				return null;
			}
			return afterLastEsc;
		}

		// Check for partial starts
		if (afterLastEsc === ESC) return afterLastEsc;
		if (afterLastEsc === `${ESC}[`) return afterLastEsc;
		if (afterLastEsc === `${ESC}]`) return afterLastEsc;
		if (afterLastEsc === `${ESC}]7`) return afterLastEsc;
		const incompleteDecset = new RegExp(`^${escEscaped}\\[\\?[0-9;]*$`);
		if (incompleteDecset.test(afterLastEsc)) return afterLastEsc;

		return null;
	}

	/**
	 * Parse DECSET/DECRST sequences from terminal data
	 */
	private parseModeChanges(data: string): void {
		const modeRegex = new RegExp(
			`${escapeRegex(ESC)}\\[\\?([0-9;]+)([hl])`,
			"g",
		);

		for (const match of data.matchAll(modeRegex)) {
			const modesStr = match[1];
			const action = match[2];
			const enable = action === "h";

			const modeNumbers = modesStr
				.split(";")
				.map((s) => Number.parseInt(s, 10));

			for (const modeNum of modeNumbers) {
				const modeName = MODE_MAP[modeNum];
				if (modeName) {
					this.modes[modeName] = enable;
				}
			}
		}
	}

	/**
	 * Parse OSC-7 sequences for CWD tracking
	 * Format: ESC]7;file://hostname/path BEL or ESC]7;file://hostname/path ESC\
	 */
	private parseOsc7(data: string): void {
		const escEscaped = escapeRegex(ESC);
		const belEscaped = escapeRegex(BEL);

		const osc7Pattern = `${escEscaped}\\]7;file://[^/]*(/.+?)(?:${belEscaped}|${escEscaped}\\\\)`;
		const osc7Regex = new RegExp(osc7Pattern, "g");

		for (const match of data.matchAll(osc7Regex)) {
			if (match[1]) {
				try {
					this.cwd = decodeURIComponent(match[1]);
				} catch {
					this.cwd = match[1];
				}
			}
		}
	}

	/**
	 * Generate escape sequences to restore current mode state
	 */
	private generateRehydrateSequences(): string {
		const sequences: string[] = [];

		const addModeSequence = (
			modeNum: number,
			enabled: boolean,
			defaultEnabled: boolean,
		) => {
			if (enabled !== defaultEnabled) {
				sequences.push(`${ESC}[?${modeNum}${enabled ? "h" : "l"}`);
			}
		};

		// Application cursor keys (mode 1)
		addModeSequence(1, this.modes.applicationCursorKeys, false);

		// Origin mode (mode 6)
		addModeSequence(6, this.modes.originMode, false);

		// Auto-wrap mode (mode 7)
		addModeSequence(7, this.modes.autoWrap, true);

		// Cursor visibility (mode 25)
		addModeSequence(25, this.modes.cursorVisible, true);

		// Mouse tracking modes
		addModeSequence(9, this.modes.mouseTrackingX10, false);
		addModeSequence(1000, this.modes.mouseTrackingNormal, false);
		addModeSequence(1001, this.modes.mouseTrackingHighlight, false);
		addModeSequence(1002, this.modes.mouseTrackingButtonEvent, false);
		addModeSequence(1003, this.modes.mouseTrackingAnyEvent, false);

		// Mouse encoding modes
		addModeSequence(1005, this.modes.mouseUtf8, false);
		addModeSequence(1006, this.modes.mouseSgr, false);

		// Focus reporting (mode 1004)
		addModeSequence(1004, this.modes.focusReporting, false);

		// Bracketed paste (mode 2004)
		addModeSequence(2004, this.modes.bracketedPaste, false);

		// Note: We don't restore alternate screen mode (1049/47) here because
		// the serialized snapshot already contains the correct screen buffer.

		return sequences.join("");
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
