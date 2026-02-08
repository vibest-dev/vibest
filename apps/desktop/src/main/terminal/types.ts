/**
 * Terminal Types
 *
 * Defines types for terminal mode tracking and state snapshots
 * for PTY persistence during tab switching.
 */

// =============================================================================
// Mode Tracking
// =============================================================================

/**
 * Terminal modes that affect input behavior and must be restored on attach.
 * These correspond to DECSET/DECRST (CSI ? Pm h/l) escape sequences.
 */
export interface TerminalModes {
	/** DECCKM - Application cursor keys (mode 1) */
	applicationCursorKeys: boolean;
	/** Bracketed paste mode (mode 2004) */
	bracketedPaste: boolean;
	/** X10 mouse tracking (mode 9) */
	mouseTrackingX10: boolean;
	/** Normal mouse tracking - button events (mode 1000) */
	mouseTrackingNormal: boolean;
	/** Highlight mouse tracking (mode 1001) */
	mouseTrackingHighlight: boolean;
	/** Button-event mouse tracking (mode 1002) */
	mouseTrackingButtonEvent: boolean;
	/** Any-event mouse tracking (mode 1003) */
	mouseTrackingAnyEvent: boolean;
	/** Focus reporting (mode 1004) */
	focusReporting: boolean;
	/** UTF-8 mouse mode (mode 1005) */
	mouseUtf8: boolean;
	/** SGR mouse mode (mode 1006) */
	mouseSgr: boolean;
	/** Alternate screen buffer (mode 1049 or 47) */
	alternateScreen: boolean;
	/** Cursor visibility (mode 25) */
	cursorVisible: boolean;
	/** Origin mode (mode 6) */
	originMode: boolean;
	/** Auto-wrap mode (mode 7) */
	autoWrap: boolean;
}

/**
 * Default terminal modes (standard terminal state)
 */
export const DEFAULT_MODES: TerminalModes = {
	applicationCursorKeys: false,
	bracketedPaste: false,
	mouseTrackingX10: false,
	mouseTrackingNormal: false,
	mouseTrackingHighlight: false,
	mouseTrackingButtonEvent: false,
	mouseTrackingAnyEvent: false,
	focusReporting: false,
	mouseUtf8: false,
	mouseSgr: false,
	alternateScreen: false,
	cursorVisible: true,
	originMode: false,
	autoWrap: true,
};

// =============================================================================
// Snapshot Types
// =============================================================================

/**
 * Snapshot payload returned when attaching to a terminal session.
 * Contains everything needed to restore terminal state in the renderer.
 */
export interface TerminalSnapshot {
	/** Serialized screen state (ANSI sequences to reproduce screen) */
	snapshotAnsi: string;
	/** Control sequences to restore input-affecting modes */
	rehydrateSequences: string;
	/** Current working directory (from OSC-7, may be null) */
	cwd: string | null;
	/** Current terminal modes */
	modes: TerminalModes;
	/** Terminal dimensions */
	cols: number;
	rows: number;
	/** Scrollback line count */
	scrollbackLines: number;
}
