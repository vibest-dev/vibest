---
title: "feat: Backend PTY Persistence for Tab Switching"
type: feat
date: 2026-02-05
---

# Backend PTY Persistence for Tab Switching

## Overview

Implement backend PTY state persistence using `@xterm/headless` and `@xterm/addon-serialize` to maintain complete terminal state when users switch between tabs. This enables seamless tab switching with full restoration of scrollback history, terminal modes, cursor position, and current working directory.

**Key insight from Superset's architecture:** Use a "shadow terminal" (headless xterm) on the backend that mirrors all PTY output. When switching tabs, serialize this shadow terminal's state and restore it on the frontend.

## Problem Statement

Currently, the vibest desktop app maintains terminal state on the frontend via continuous streaming. While this works when tabs are hidden via CSS, there are gaps:

1. **No recovery mechanism** - If frontend misses data (subscription interruption), state is lost
2. **No mode tracking** - Terminal modes (bracketed paste, application cursor, etc.) aren't tracked
3. **No CWD tracking** - Current working directory changes aren't captured (OSC-7)
4. **Frontend authority** - Backend has no state to provide if frontend restarts

## Proposed Solution

Add `@xterm/headless` on the backend to maintain authoritative terminal state:

```
┌──────────────────────────────────────────────────────────────────┐
│                        Backend (Main Process)                     │
│                                                                   │
│  ┌──────────────┐        ┌─────────────────────────────────────┐ │
│  │  PTY Process │ ─────▶ │  HeadlessTerminal (@xterm/headless) │ │
│  │  (node-pty)  │  data  │  - Maintains complete terminal state │ │
│  └──────────────┘        │  - SerializeAddon for snapshots      │ │
│         │                │  - Mode tracking (DEC modes)         │ │
│         │                │  - CWD tracking (OSC-7)              │ │
│         ▼                └─────────────────────────────────────┘ │
│  ┌──────────────┐                       │                        │
│  │  DataBatcher │                       │ getSnapshot()          │
│  │  (existing)  │                       ▼                        │
│  └──────────────┘        ┌─────────────────────────────────────┐ │
│         │                │  TerminalSnapshot                    │ │
│         │                │  { snapshotAnsi, modes, cwd, ... }   │ │
│         ▼                └─────────────────────────────────────┘ │
│  Stream to Frontend                                               │
└──────────────────────────────────────────────────────────────────┘
```

## Technical Approach

### Architecture

#### Data Flow

```
PTY Output → HeadlessTerminal.write() → [state captured]
                    ↓
            DataBatcher.write() → Stream to Frontend
                    ↓
            Frontend xterm.write() → [render]

Tab Switch:
1. Frontend calls terminal.attach({ terminalId })
2. Backend calls headless.getSnapshot()
3. Backend returns { snapshotAnsi, modes, cwd }
4. Frontend applies: xterm.write(rehydrateSequences + snapshotAnsi)
```

#### Key Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `HeadlessTerminal` | `apps/desktop/src/main/terminal/headless-terminal.ts` | Wraps @xterm/headless with mode tracking |
| `TerminalInstance` | `apps/desktop/src/main/terminal/terminal-manager.ts` | Extended to include HeadlessTerminal |
| `terminal.attach` | `apps/desktop/src/shared/contract/terminal.ts` | New RPC for state sync |
| `TerminalView` | `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx` | Updated to sync on visibility |

### Implementation Phases

#### Phase 1: Backend Foundation

**Tasks:**
- [ ] Add dependencies: `@xterm/headless`, `@xterm/addon-serialize`
- [ ] Create `HeadlessTerminal` class with:
  - Mode tracking (DECSET/DECRST parsing)
  - OSC-7 parsing for CWD
  - `getSnapshot()` method using SerializeAddon
  - `generateRehydrateSequences()` for mode restoration
- [ ] Extend `TerminalInstance` to include `HeadlessTerminal`
- [ ] Update `TerminalManager.create()` to initialize headless terminal
- [ ] Wire PTY output to both DataBatcher and HeadlessTerminal

**Files to create/modify:**
```
apps/desktop/src/main/terminal/
├── headless-terminal.ts     (new)
├── terminal-manager.ts      (modify)
└── types.ts                 (modify - add TerminalSnapshot)
```

**Success criteria:**
- HeadlessTerminal receives all PTY output
- State can be serialized via `getSnapshot()`
- Terminal modes are tracked correctly

**Estimated complexity:** Medium

#### Phase 2: RPC Layer

**Tasks:**
- [ ] Define `TerminalSnapshotSchema` in contract
- [ ] Add `terminal.attach` RPC endpoint:
  ```typescript
  attach: oc
    .input(z.object({ terminalId: z.string() }))
    .output(TerminalSnapshotSchema)
  ```
- [ ] Implement `attach` handler in terminal router
- [ ] Add flush mechanism to ensure consistent state during serialization

**Files to create/modify:**
```
apps/desktop/src/shared/contract/terminal.ts  (modify)
apps/desktop/src/main/ipc/router/terminal.ts  (modify)
```

**Success criteria:**
- Client can call `terminal.attach` and receive complete state
- State includes scrollback, modes, cwd, cursor position

**Estimated complexity:** Low

#### Phase 3: Frontend Integration

**Tasks:**
- [ ] Update `TerminalView` to sync state on visibility change:
  ```typescript
  useEffect(() => {
    if (isVisible) {
      const snapshot = await client.terminal.attach({ terminalId })
      terminal.write(snapshot.rehydrateSequences)
      terminal.write(snapshot.snapshotAnsi)
    }
  }, [isVisible])
  ```
- [ ] Update scrollback configuration from 1000 to 10000 lines
- [ ] Handle state sync errors gracefully
- [ ] Add loading state during sync

**Files to modify:**
```
apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx
```

**Success criteria:**
- Tab switching restores complete terminal state
- vim/less (alternate screen) restores correctly
- CWD is displayed correctly after switch

**Estimated complexity:** Medium

#### Phase 4: Polish & Edge Cases

**Tasks:**
- [ ] Handle resize during state transfer
- [ ] Handle process exit while tab is hidden
- [ ] Add proper disposal sequence (batcher → headless → PTY)
- [ ] Handle rapid tab switching (debounce/cancel)
- [ ] Memory profiling with 20 terminals

**Success criteria:**
- No memory leaks under sustained use
- No race conditions during rapid switching
- Graceful handling of all error scenarios

**Estimated complexity:** Medium

## Alternative Approaches Considered

### 1. Frontend-Only State (Current)

**Description:** Keep using CSS `visibility: hidden` and continuous streaming.

**Why rejected:**
- No recovery if frontend misses data
- No mode/CWD tracking
- Frontend restart loses all state

### 2. Scrollback Buffer Only (No Headless)

**Description:** Store raw PTY output in a string buffer on backend.

**Why rejected:**
- Loses escape sequence parsing
- Can't extract modes or CWD
- Would need custom serialization

### 3. Full Superset Architecture

**Description:** Copy Superset's complete implementation including cold restore.

**Why rejected:**
- Over-engineered for runtime-only persistence
- Adds complexity without benefit (no restart persistence needed)
- Subprocess-based PTY isolation unnecessary for desktop app

## Acceptance Criteria

### Functional Requirements

- [ ] Terminal state is fully restored when switching tabs
- [ ] Scrollback history (10000 lines) is preserved
- [ ] Terminal modes are restored:
  - [ ] Bracketed paste mode (mode 2004)
  - [ ] Application cursor keys (mode 1)
  - [ ] Alternate screen buffer (mode 1049)
  - [ ] Mouse tracking modes
  - [ ] Cursor visibility (mode 25)
- [ ] Current working directory is tracked via OSC-7
- [ ] vim/less applications restore correctly
- [ ] Long-running commands continue while tab is hidden

### Non-Functional Requirements

- [ ] Tab switch with state sync < 100ms for typical scrollback
- [ ] Memory usage < 2MB per terminal (10000 lines)
- [ ] Support 20 concurrent terminals per workspace
- [ ] No memory leaks under sustained use (1hr+ session)

### Quality Gates

- [ ] Unit tests for HeadlessTerminal (mode parsing, serialization)
- [ ] Integration tests for attach RPC
- [ ] E2E tests for tab switching scenarios
- [ ] Memory profiling test

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| State sync latency | < 100ms | Performance profiling |
| Memory per terminal | < 2MB | Memory profiling |
| State restoration accuracy | 100% | E2E test coverage |

## Dependencies & Prerequisites

### Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@xterm/headless` | ^5.5.0 | Headless terminal emulator |
| `@xterm/addon-serialize` | ^0.13.0 | State serialization |

### Prerequisites

- Existing terminal implementation (TerminalManager, TerminalView)
- @orpc streaming infrastructure
- Zustand state management

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Memory pressure with 20 terminals | Medium | High | Monitor memory, implement pruning |
| State sync race conditions | Medium | Medium | Debounce, cancel pending requests |
| Mode parsing edge cases | Low | Medium | Extensive testing, reference Superset |
| OSC-7 shell configuration | Medium | Low | Document setup, show warning |

## Resource Requirements

- **Packages:** @xterm/headless, @xterm/addon-serialize
- **New files:** ~3 files, ~500 lines
- **Modified files:** ~5 files

## Future Considerations

1. **Cold Restore (App Restart)** - Could persist state to disk if needed later
2. **Tab Activity Indicator** - Show when hidden tab has new output
3. **Scrollback Compression** - Compress old lines to reduce memory
4. **Agent Integration** - Agent tools could query terminal state

## Documentation Plan

- [ ] Update terminal section in CLAUDE.md if needed
- [ ] Add inline code comments for complex logic
- [ ] Document shell configuration for OSC-7 in README

## References & Research

### Internal References

- Existing terminal: `apps/desktop/src/main/terminal/terminal-manager.ts`
- Contract pattern: `apps/desktop/src/shared/contract/terminal.ts`
- Router pattern: `apps/desktop/src/main/ipc/router/terminal.ts`
- Frontend component: `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx`

### External References

- Superset implementation: `/tmp/superset-sh/superset/apps/desktop/src/main/terminal-host/`
- @xterm/headless: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-headless
- @xterm/addon-serialize: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize

### Design Inspiration

Superset's `HeadlessEmulator` class provides the reference implementation:
- Mode tracking via escape sequence parsing
- OSC-7 parsing for CWD
- `getSnapshot()` returning serialized state + rehydrate sequences
- Flush mechanism for consistent state during active output

---

## Appendix: Terminal Modes to Track

| Mode | Number | Description |
|------|--------|-------------|
| Application Cursor Keys | 1 | Arrow keys send application sequences |
| Origin Mode | 6 | Cursor addressing relative to scroll region |
| Auto Wrap | 7 | Automatic line wrapping |
| X10 Mouse | 9 | Basic mouse click reporting |
| Cursor Visible | 25 | Show/hide cursor |
| Alternate Screen | 47/1049 | Full-screen app buffer |
| Normal Mouse | 1000 | Mouse button press/release |
| Highlight Mouse | 1001 | Highlight tracking |
| Button Event Mouse | 1002 | Report button motion |
| Any Event Mouse | 1003 | Report all motion |
| Focus Reporting | 1004 | Focus in/out events |
| UTF8 Mouse | 1005 | UTF-8 mouse encoding |
| SGR Mouse | 1006 | SGR mouse encoding |
| Bracketed Paste | 2004 | Paste mode brackets |

## Appendix: TerminalSnapshot Schema

```typescript
interface TerminalSnapshot {
  // Serialized terminal content (ANSI escape sequences)
  snapshotAnsi: string;

  // Escape sequences to restore terminal modes
  rehydrateSequences: string;

  // Current working directory (from OSC-7)
  cwd: string | null;

  // Terminal modes state
  modes: {
    applicationCursorKeys: boolean;
    bracketedPaste: boolean;
    alternateScreen: boolean;
    cursorVisible: boolean;
    originMode: boolean;
    autoWrap: boolean;
    mouseTrackingX10: boolean;
    mouseTrackingNormal: boolean;
    mouseTrackingButtonEvent: boolean;
    mouseTrackingAnyEvent: boolean;
    focusReporting: boolean;
    mouseUtf8: boolean;
    mouseSgr: boolean;
  };

  // Terminal dimensions
  cols: number;
  rows: number;

  // Scrollback line count
  scrollbackLines: number;
}
```

## Appendix: OSC-7 Shell Configuration

For CWD tracking to work, the shell must emit OSC-7 sequences. Example configurations:

**Zsh (~/.zshrc):**
```bash
# Emit OSC-7 on directory change
autoload -Uz add-zsh-hook
function osc7_cwd() {
  printf '\e]7;file://%s%s\e\\' "${HOST}" "${PWD}"
}
add-zsh-hook chpwd osc7_cwd
osc7_cwd  # Emit on shell start
```

**Bash (~/.bashrc):**
```bash
# Emit OSC-7 on prompt
PROMPT_COMMAND='printf "\e]7;file://%s%s\e\\" "${HOSTNAME}" "${PWD}"'
```

**Fish (~/.config/fish/config.fish):**
```fish
function osc7_cwd --on-variable PWD
  printf '\e]7;file://%s%s\e\\' (hostname) $PWD
end
```
