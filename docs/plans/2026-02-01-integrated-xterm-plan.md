# Integrated xterm Terminal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add interactive xterm.js terminals to the Electron desktop app, with one set of terminal tabs per worktree, persisting across worktree switches.

**Architecture:** Main process manages PTY instances via `TerminalManager` (lifecycle) + `TerminalService` (IPC). Renderer uses xterm.js with FitAddon + WebglAddon, Zustand for UI state, TanStack Query for terminal list data. Terminals stay alive when switching worktrees.

**Tech Stack:** node-pty, @xterm/xterm, @xterm/addon-fit, @xterm/addon-webgl, Zustand slices, oRPC IPC

---

## Task 1: Install Dependencies

**Files:**

- Modify: `apps/desktop/package.json`

**Step 1: Add node-pty and xterm.js packages**

```bash
cd apps/desktop && pnpm add node-pty @xterm/xterm @xterm/addon-fit @xterm/addon-webgl
```

**Step 2: Verify installation**

Run: `cd apps/desktop && pnpm ls node-pty @xterm/xterm`
Expected: Both packages listed with versions

**Step 3: Commit**

```bash
git add apps/desktop/package.json apps/desktop/pnpm-lock.yaml pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(desktop): add node-pty and xterm.js dependencies
EOF
)"
```

---

## Task 2: Create Terminal Contract

**Files:**

- Create: `apps/desktop/src/shared/contract/terminal.ts`
- Modify: `apps/desktop/src/shared/contract/index.ts`

**Step 1: Create terminal contract file**

```typescript
// apps/desktop/src/shared/contract/terminal.ts
import { oc } from "@orpc/contract";
import { z } from "zod";

export const TerminalInfoSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  title: z.string(),
});

export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const terminalContract = {
  create: oc
    .input(
      z.object({
        worktreeId: z.string(),
        cwd: z.string(),
      }),
    )
    .output(TerminalInfoSchema),

  list: oc
    .input(
      z.object({
        worktreeId: z.string(),
      }),
    )
    .output(z.array(TerminalInfoSchema)),

  write: oc.input(
    z.object({
      terminalId: z.string(),
      data: z.string(),
    }),
  ),

  resize: oc.input(
    z.object({
      terminalId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }),
  ),

  close: oc.input(
    z.object({
      terminalId: z.string(),
    }),
  ),
};
```

**Step 2: Export from contract index**

Edit `apps/desktop/src/shared/contract/index.ts`:

```typescript
import { fsContract } from "./fs";
import { gitContract } from "./git";
import { terminalContract } from "./terminal";
import { workspaceContract } from "./workspace";

export const contract = {
  workspace: workspaceContract,
  git: gitContract,
  fs: fsContract,
  terminal: terminalContract,
};

export type Contract = typeof contract;

export { fsContract, gitContract, terminalContract, workspaceContract };
```

**Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/desktop/src/shared/contract/terminal.ts apps/desktop/src/shared/contract/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add terminal IPC contract
EOF
)"
```

---

## Task 3: Create TerminalManager

**Files:**

- Create: `apps/desktop/src/main/terminal/terminal-manager.ts`

**Step 1: Create terminal manager**

```typescript
// apps/desktop/src/main/terminal/terminal-manager.ts
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
```

**Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/desktop/src/main/terminal/terminal-manager.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add TerminalManager for PTY lifecycle
EOF
)"
```

---

## Task 4: Create Terminal IPC Router

**Files:**

- Create: `apps/desktop/src/main/ipc/router/terminal.ts`
- Modify: `apps/desktop/src/main/ipc/router/index.ts`

**Step 1: Create terminal router**

```typescript
// apps/desktop/src/main/ipc/router/terminal.ts
import { implement } from "@orpc/server";

import type { AppContext } from "../../app";

import { terminalContract } from "../../../shared/contract/terminal";

const os = implement(terminalContract).$context<AppContext>();

export const create = os.create.handler(async ({ input, context: { app } }) => {
  const { worktreeId, cwd } = input;
  const instance = app.terminal.create(worktreeId, cwd);
  return {
    id: instance.id,
    worktreeId: instance.worktreeId,
    title: instance.title,
  };
});

export const list = os.list.handler(async ({ input, context: { app } }) => {
  const { worktreeId } = input;
  const terminals = app.terminal.getTerminalsByWorktree(worktreeId);
  return terminals.map((t) => ({
    id: t.id,
    worktreeId: t.worktreeId,
    title: t.title,
  }));
});

export const write = os.write.handler(async ({ input, context: { app } }) => {
  const { terminalId, data } = input;
  app.terminal.write(terminalId, data);
});

export const resize = os.resize.handler(async ({ input, context: { app } }) => {
  const { terminalId, cols, rows } = input;
  app.terminal.resize(terminalId, cols, rows);
});

export const close = os.close.handler(async ({ input, context: { app } }) => {
  const { terminalId } = input;
  const instance = app.terminal.get(terminalId);
  if (instance) {
    const worktreeId = instance.worktreeId;
    app.terminal.close(terminalId);
    app.terminal.recalculateTitles(worktreeId);
  }
});

export const terminalRouter = os.router({
  create,
  list,
  write,
  resize,
  close,
});
```

**Step 2: Add terminal router to main router**

Edit `apps/desktop/src/main/ipc/router/index.ts`:

```typescript
import { implement } from "@orpc/server";

import type { AppContext } from "../../app";

import { contract } from "../../../shared/contract";
import { fsRouter } from "./fs";
import { gitRouter } from "./git";
import { terminalRouter } from "./terminal";
import { workspaceRouter } from "./workspace";

const os = implement(contract).$context<AppContext>();

export const router = os.router({
  workspace: workspaceRouter,
  git: gitRouter,
  fs: fsRouter,
  terminal: terminalRouter,
});

export type Router = typeof router;
```

**Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/desktop/src/main/ipc/router/terminal.ts apps/desktop/src/main/ipc/router/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add terminal IPC router
EOF
)"
```

---

## Task 5: Integrate TerminalManager into App

**Files:**

- Modify: `apps/desktop/src/main/app.ts`
- Create: `apps/desktop/src/main/terminal/index.ts`

**Step 1: Create terminal module index**

```typescript
// apps/desktop/src/main/terminal/index.ts
export { TerminalManager } from "./terminal-manager";
export type { TerminalEventHandler, TerminalInstance } from "./terminal-manager";
```

**Step 2: Add TerminalManager to App class**

Edit `apps/desktop/src/main/app.ts`:

```typescript
import { TerminalManager } from "./terminal";
import { GitService, StoreService, WorktreeService } from "./services";

export class App {
  readonly store: StoreService;
  readonly git: GitService;
  readonly worktree: WorktreeService;
  readonly terminal: TerminalManager;

  constructor() {
    this.store = new StoreService();
    this.git = new GitService();
    this.worktree = new WorktreeService(this.store, this.git);
    this.terminal = new TerminalManager();
  }

  async start(): Promise<void> {
    // Initialization logic if needed
    console.log("[App] Started");
  }

  async stop(): Promise<void> {
    // Cleanup terminal instances
    this.terminal.dispose();
    console.log("[App] Stopped");
  }
}

export type AppContext = { app: App };
```

**Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:node`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/desktop/src/main/terminal/index.ts apps/desktop/src/main/app.ts
git commit -m "$(cat <<'EOF'
feat(desktop): integrate TerminalManager into App
EOF
)"
```

---

## Task 6: Setup Terminal IPC Events (Main → Renderer)

**Files:**

- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Step 1: Setup terminal event forwarding in IPC**

Edit `apps/desktop/src/main/ipc/index.ts`:

```typescript
import { RPCHandler } from "@orpc/server/message-port";
import { BrowserWindow, ipcMain } from "electron";

import type { App } from "../app";

import { router } from "./router";

export function setupIPC(app: App): void {
  const handler = new RPCHandler(router);

  ipcMain.on("orpc:connect", (event) => {
    const [serverPort] = event.ports;
    handler.upgrade(serverPort, { context: { app } });
    serverPort.start();
  });

  // Setup terminal event forwarding to renderer
  app.terminal.setEventHandler({
    onData: (terminalId, data) => {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send(`terminal:data:${terminalId}`, data);
      }
    },
    onExit: (terminalId, exitCode) => {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send(`terminal:exit:${terminalId}`, { exitCode });
      }
    },
  });
}
```

**Step 2: Expose terminal IPC in preload**

Edit `apps/desktop/src/preload/index.ts`:

```typescript
import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";

// Forward MessagePort from renderer to main process for oRPC
window.addEventListener("message", (event) => {
  if (event.data === "orpc:connect" && event.ports[0]) {
    ipcRenderer.postMessage("orpc:connect", null, [event.ports[0]]);
  }
});

// Terminal IPC API
const terminalAPI = {
  onData: (terminalId: string, callback: (data: string) => void) => {
    const channel = `terminal:data:${terminalId}`;
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onExit: (terminalId: string, callback: (exitCode: number) => void) => {
    const channel = `terminal:exit:${terminalId}`;
    const listener = (_event: Electron.IpcRendererEvent, { exitCode }: { exitCode: number }) =>
      callback(exitCode);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("terminalAPI", terminalAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
  // @ts-expect-error (define in dts)
  window.terminalAPI = terminalAPI;
}
```

**Step 3: Add terminalAPI type declaration**

Edit `apps/desktop/src/renderer/src/env.d.ts`:

```typescript
/// <reference types="vite/client" />

interface TerminalAPI {
  onData: (terminalId: string, callback: (data: string) => void) => () => void;
  onExit: (terminalId: string, callback: (exitCode: number) => void) => () => void;
}

declare global {
  interface Window {
    terminalAPI: TerminalAPI;
  }
}
```

**Step 4: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/env.d.ts
git commit -m "$(cat <<'EOF'
feat(desktop): setup terminal IPC events main→renderer
EOF
)"
```

---

## Task 7: Refactor UI Store to App Store with Slices

**Files:**

- Create: `apps/desktop/src/renderer/src/stores/slices/ui-slice.ts`
- Create: `apps/desktop/src/renderer/src/stores/slices/terminal-slice.ts`
- Create: `apps/desktop/src/renderer/src/stores/slices/index.ts`
- Create: `apps/desktop/src/renderer/src/stores/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/stores/index.ts`

**Step 1: Create UI slice**

```typescript
// apps/desktop/src/renderer/src/stores/slices/ui-slice.ts
import type { StateCreator } from "zustand";

export interface UISlice {
  // Worktree selection
  selectedWorktreeId: string | null;
  selectWorktree: (id: string | null) => void;

  // Repository expansion
  expandedRepositories: string[];
  toggleRepository: (id: string) => void;
  expandRepository: (id: string) => void;
  collapseRepository: (id: string) => void;
  setExpandedRepositories: (ids: string[]) => void;

  // Layout
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
}

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
  // State
  selectedWorktreeId: null,
  expandedRepositories: [],
  sidebarWidth: 240,

  // Actions
  selectWorktree: (id) => set({ selectedWorktreeId: id }),

  toggleRepository: (id) =>
    set((state) => ({
      expandedRepositories: state.expandedRepositories.includes(id)
        ? state.expandedRepositories.filter((x) => x !== id)
        : [...state.expandedRepositories, id],
    })),

  expandRepository: (id) =>
    set((state) => ({
      expandedRepositories: state.expandedRepositories.includes(id)
        ? state.expandedRepositories
        : [...state.expandedRepositories, id],
    })),

  collapseRepository: (id) =>
    set((state) => ({
      expandedRepositories: state.expandedRepositories.filter((x) => x !== id),
    })),

  setExpandedRepositories: (ids) => set({ expandedRepositories: ids }),

  setSidebarWidth: (width) => set({ sidebarWidth: width }),
});
```

**Step 2: Create terminal slice**

```typescript
// apps/desktop/src/renderer/src/stores/slices/terminal-slice.ts
import type { StateCreator } from "zustand";

export interface TerminalSlice {
  // Active terminal per worktree
  activeTerminalId: Record<string, string | null>;
  setActiveTerminalId: (worktreeId: string, terminalId: string | null) => void;
  clearActiveTerminalId: (worktreeId: string) => void;
}

export const createTerminalSlice: StateCreator<TerminalSlice, [], [], TerminalSlice> = (set) => ({
  // State
  activeTerminalId: {},

  // Actions
  setActiveTerminalId: (worktreeId, terminalId) =>
    set((state) => ({
      activeTerminalId: {
        ...state.activeTerminalId,
        [worktreeId]: terminalId,
      },
    })),

  clearActiveTerminalId: (worktreeId) =>
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.activeTerminalId;
      return { activeTerminalId: rest };
    }),
});
```

**Step 3: Create slices index**

```typescript
// apps/desktop/src/renderer/src/stores/slices/index.ts
export { createTerminalSlice, type TerminalSlice } from "./terminal-slice";
export { createUISlice, type UISlice } from "./ui-slice";
```

**Step 4: Create app store combining slices**

```typescript
// apps/desktop/src/renderer/src/stores/app-store.ts
import { useStore } from "zustand";
import { persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { createTerminalSlice, createUISlice } from "./slices";

import type { TerminalSlice, UISlice } from "./slices";

export type AppStore = UISlice & TerminalSlice;

// Vanilla store - can be used outside React
export const appStore = createStore<AppStore>()(
  persist(
    (...a) => ({
      ...createUISlice(...a),
      ...createTerminalSlice(...a),
    }),
    {
      name: "vibest-app",
      // Only persist user preferences, not transient UI state
      partialize: (state) => ({
        expandedRepositories: state.expandedRepositories,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);

// React hook with selector support
export function useAppStore<T>(selector: (state: AppStore) => T): T {
  return useStore(appStore, selector);
}
```

**Step 5: Update stores index**

```typescript
// apps/desktop/src/renderer/src/stores/index.ts
// App store (combined slices with persistence)
export { appStore, useAppStore, type AppStore } from "./app-store";

// Legacy export for gradual migration
export { appStore as uiStore, useAppStore as useUIStore } from "./app-store";
```

**Step 6: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/
git commit -m "$(cat <<'EOF'
refactor(desktop): migrate to app store with slices
EOF
)"
```

---

## Task 8: Create Terminal Query Hooks

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/queries/terminal.ts`

**Step 1: Create terminal query utilities**

```typescript
// apps/desktop/src/renderer/src/lib/queries/terminal.ts
import { createORPCReactQueryUtils } from "@orpc/tanstack-query/react";

import type { TerminalInfo } from "../../../../shared/contract/terminal";

import { client } from "../client";
import { queryClient } from "../query-client";
import { appStore } from "../../stores/app-store";

export const terminalOrpc = createORPCReactQueryUtils(client.terminal, {
  path: ["terminal"],
});

// Mutation callbacks for terminal operations
export function createTerminalMutationCallbacks() {
  return {
    onSuccess: (data: TerminalInfo) => {
      // Invalidate terminal list for this worktree
      queryClient.invalidateQueries({
        queryKey: ["terminal", "list", { input: { worktreeId: data.worktreeId } }],
      });
      // Set as active terminal
      appStore.getState().setActiveTerminalId(data.worktreeId, data.id);
    },
  };
}

export function closeTerminalMutationCallbacks(worktreeId: string) {
  return {
    onSuccess: () => {
      // Invalidate terminal list
      queryClient.invalidateQueries({
        queryKey: ["terminal", "list", { input: { worktreeId } }],
      });
    },
  };
}
```

**Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/queries/terminal.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add terminal query utilities
EOF
)"
```

---

## Task 9: Create TerminalView Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx`

**Step 1: Create xterm.js wrapper component**

```typescript
// apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { client } from "../../lib/client";

interface TerminalViewProps {
  terminalId: string;
  isVisible: boolean;
}

export function TerminalView({ terminalId, isVisible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize terminal once
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 14,
      fontFamily: '"Geist Mono Variable", Menlo, Monaco, monospace',
      fontWeight: "normal",
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#0a0a0a",
        foreground: "#fafafa",
        cursor: "#fafafa",
        cursorAccent: "#0a0a0a",
        selectionBackground: "#3f3f46",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#fafafa",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Try WebGL renderer with fallback
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      console.warn("WebGL addon failed, using canvas renderer");
    }

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle user input → send to PTY
    const dataDisposable = terminal.onData((data) => {
      client.terminal.write({ terminalId, data });
    });

    // Sync resize to PTY
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      client.terminal.resize({ terminalId, cols, rows });
    });

    // Receive PTY output
    const unsubData = window.terminalAPI.onData(terminalId, (data) => {
      terminal.write(data);
    });

    // Handle PTY exit
    const unsubExit = window.terminalAPI.onExit(terminalId, (_exitCode) => {
      terminal.writeln("\r\n[Process exited]");
    });

    // Cleanup
    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      unsubData();
      unsubExit();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  // Handle visibility changes - fit when becoming visible
  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      // Small delay to ensure container is rendered
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      });
    }
  }, [isVisible]);

  // Handle container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (isVisible) {
        fitAddonRef.current?.fit();
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [isVisible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: isVisible ? "block" : "none" }}
    />
  );
}
```

**Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): add TerminalView xterm.js component
EOF
)"
```

---

## Task 10: Create TerminalTabs Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx`

**Step 1: Create terminal tabs component**

```typescript
// apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { Plus, X } from "lucide-react";

import type { TerminalInfo } from "../../../../shared/contract/terminal";

import { closeTerminalMutationCallbacks, createTerminalMutationCallbacks, terminalOrpc } from "../../lib/queries/terminal";
import { useAppStore } from "../../stores";

interface TerminalTabsProps {
  worktreeId: string;
  worktreePath: string;
}

export function TerminalTabs({ worktreeId, worktreePath }: TerminalTabsProps) {
  const activeTerminalId = useAppStore((s) => s.activeTerminalId[worktreeId] ?? null);
  const setActiveTerminalId = useAppStore((s) => s.setActiveTerminalId);

  // Query terminals for this worktree
  const { data: terminals = [] } = useQuery(
    terminalOrpc.list.queryOptions({ input: { worktreeId } }),
  );

  // Create terminal mutation
  const createMutation = useMutation({
    ...terminalOrpc.create.mutationOptions(),
    ...createTerminalMutationCallbacks(),
  });

  // Close terminal mutation
  const closeMutation = useMutation({
    ...terminalOrpc.close.mutationOptions(),
    ...closeTerminalMutationCallbacks(worktreeId),
    onSuccess: () => {
      // After closing, select another terminal or create new one
      const remaining = terminals.filter((t) => t.id !== activeTerminalId);
      if (remaining.length > 0) {
        setActiveTerminalId(worktreeId, remaining[0].id);
      } else {
        // Create new terminal (at least one rule)
        createMutation.mutate({ worktreeId, cwd: worktreePath });
      }
    },
  });

  const handleCreate = () => {
    createMutation.mutate({ worktreeId, cwd: worktreePath });
  };

  const handleClose = (terminalId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeMutation.mutate({ terminalId });
  };

  const handleSelect = (terminal: TerminalInfo) => {
    setActiveTerminalId(worktreeId, terminal.id);
  };

  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2">
      {terminals.map((terminal) => (
        <button
          key={terminal.id}
          type="button"
          onClick={() => handleSelect(terminal)}
          className={`group flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors ${
            activeTerminalId === terminal.id
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          <span>{terminal.title}</span>
          <button
            type="button"
            onClick={(e) => handleClose(terminal.id, e)}
            className="hover:bg-foreground/10 -mr-1 flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </button>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={handleCreate}
        disabled={createMutation.isPending}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

**Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): add TerminalTabs component
EOF
)"
```

---

## Task 11: Create TerminalContainer Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/terminal/terminal-container.tsx`
- Create: `apps/desktop/src/renderer/src/components/terminal/index.ts`

**Step 1: Create terminal container**

```typescript
// apps/desktop/src/renderer/src/components/terminal/terminal-container.tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { Worktree } from "../../types";

import { createTerminalMutationCallbacks, terminalOrpc } from "../../lib/queries/terminal";
import { useAppStore } from "../../stores";
import { TerminalTabs } from "./terminal-tabs";
import { TerminalView } from "./terminal-view";

interface TerminalContainerProps {
  worktree: Worktree;
}

export function TerminalContainer({ worktree }: TerminalContainerProps) {
  const activeTerminalId = useAppStore((s) => s.activeTerminalId[worktree.id] ?? null);
  const setActiveTerminalId = useAppStore((s) => s.setActiveTerminalId);
  const initializedRef = useRef(false);

  // Query terminals for this worktree
  const { data: terminals = [], isLoading } = useQuery(
    terminalOrpc.list.queryOptions({ input: { worktreeId: worktree.id } }),
  );

  // Create terminal mutation
  const createMutation = useMutation({
    ...terminalOrpc.create.mutationOptions(),
    ...createTerminalMutationCallbacks(),
  });

  // Auto-create first terminal when none exist
  useEffect(() => {
    if (!isLoading && terminals.length === 0 && !initializedRef.current) {
      initializedRef.current = true;
      createMutation.mutate({ worktreeId: worktree.id, cwd: worktree.path });
    }
  }, [isLoading, terminals.length, worktree.id, worktree.path, createMutation]);

  // Set active terminal if none selected
  useEffect(() => {
    if (terminals.length > 0 && !activeTerminalId) {
      setActiveTerminalId(worktree.id, terminals[0].id);
    }
  }, [terminals, activeTerminalId, worktree.id, setActiveTerminalId]);

  // Reset initialized ref when worktree changes
  useEffect(() => {
    initializedRef.current = false;
  }, [worktree.id]);

  return (
    <div className="flex h-full flex-col">
      <TerminalTabs worktreeId={worktree.id} worktreePath={worktree.path} />
      <div className="bg-[#0a0a0a] relative flex-1">
        {terminals.map((terminal) => (
          <TerminalView
            key={terminal.id}
            terminalId={terminal.id}
            isVisible={terminal.id === activeTerminalId}
          />
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create terminal index**

```typescript
// apps/desktop/src/renderer/src/components/terminal/index.ts
export { TerminalContainer } from "./terminal-container";
export { TerminalTabs } from "./terminal-tabs";
export { TerminalView } from "./terminal-view";
```

**Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/terminal/
git commit -m "$(cat <<'EOF'
feat(desktop): add TerminalContainer component
EOF
)"
```

---

## Task 12: Integrate Terminal into App

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/layout/sidebar.tsx`

**Step 1: Update App to show terminal instead of diff viewer**

Edit `apps/desktop/src/renderer/src/App.tsx` - replace `DiffViewer` usage with `TerminalContainer`:

```typescript
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Worktree } from "./types";

import { Header } from "./components/layout/header";
import { MainContent } from "./components/layout/main-content";
import { Sidebar } from "./components/layout/sidebar";
import { AddRepositoryDialog } from "./components/repositories/add-repository-dialog";
import { CloneRepositoryDialog } from "./components/repositories/clone-repository-dialog";
import { TerminalContainer } from "./components/terminal";
import { CreateWorktreeDialog } from "./components/worktrees/create-worktree-dialog";
import { client } from "./lib/client";
import {
  addRepositoryMutationCallbacks,
  archiveWorktreeMutationCallbacks,
  cloneRepositoryMutationCallbacks,
  createWorktreeMutationCallbacks,
  orpc,
  quickCreateWorktreeMutationCallbacks,
  removeRepositoryMutationCallbacks,
} from "./lib/queries/workspace";
import { useAppStore } from "./stores";

function App(): React.JSX.Element {
  // Server state - TanStack Query via oRPC
  const {
    data: workspaceData,
    isLoading: isLoadingRepositories,
    error: queryError,
  } = useQuery(orpc.workspace.list.queryOptions({}));

  const repositories = useMemo(
    () => workspaceData?.repositories ?? [],
    [workspaceData?.repositories],
  );
  const worktreesByRepository = workspaceData?.worktreesByRepository ?? {};

  // UI state - Zustand
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const expandedRepositories = useAppStore((s) => s.expandedRepositories);
  const toggleRepository = useAppStore((s) => s.toggleRepository);
  const expandRepository = useAppStore((s) => s.expandRepository);
  const setExpandedRepositories = useAppStore((s) => s.setExpandedRepositories);

  // Local UI state (transient, not persisted)
  const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateWorktreeDialog, setShowCreateWorktreeDialog] = useState(false);
  const [createWorktreeRepositoryId, setCreateWorktreeRepositoryId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Find selected worktree from all worktrees
  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) return null;
    for (const worktrees of Object.values(worktreesByRepository)) {
      const found = worktrees.find((w) => w.id === selectedWorktreeId);
      if (found) return found;
    }
    return null;
  }, [selectedWorktreeId, worktreesByRepository]);

  // Mutations using oRPC TanStack Query utils
  const addRepoMutation = useMutation({
    ...orpc.workspace.addRepository.mutationOptions(),
    ...addRepositoryMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  const cloneRepoMutation = useMutation({
    ...orpc.workspace.cloneRepository.mutationOptions(),
    ...cloneRepositoryMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  const removeRepoMutation = useMutation({
    ...orpc.workspace.removeRepository.mutationOptions(),
    ...removeRepositoryMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  const createWorktreeMut = useMutation({
    ...orpc.workspace.createWorktree.mutationOptions(),
    ...createWorktreeMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  const quickCreateMutation = useMutation({
    ...orpc.workspace.quickCreateWorktree.mutationOptions(),
    ...quickCreateWorktreeMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  const archiveMutation = useMutation({
    ...orpc.workspace.archiveWorktree.mutationOptions(),
    ...archiveWorktreeMutationCallbacks(),
    onError: (error) => setMutationError(String(error)),
  });

  // Initialize expanded repositories - expand all on first load if none are expanded
  useEffect(() => {
    if (repositories.length > 0 && expandedRepositories.length === 0 && !isLoadingRepositories) {
      setExpandedRepositories(repositories.map((r) => r.id));
    }
  }, [repositories, expandedRepositories.length, isLoadingRepositories, setExpandedRepositories]);

  // Get selected repository
  const selectedRepository = selectedWorktree
    ? (repositories.find((r) => r.id === selectedWorktree.repositoryId) ?? null)
    : null;

  const error = queryError ? String(queryError) : mutationError;

  const handleAddRepository = async () => {
    try {
      const selectedPath = await client.fs.selectDir();
      if (selectedPath) {
        setAddRepositoryPath(selectedPath);
      }
    } catch (err) {
      console.error("Failed to select directory:", err);
    }
  };

  const handleCreateWorktree = async (repositoryId: string) => {
    // Quick create worktree directly without dialog
    await quickCreateMutation.mutateAsync({ repositoryId });
  };

  const handleToggleRepository = useCallback(
    (repositoryId: string, open: boolean) => {
      if (open) {
        expandRepository(repositoryId);
      } else {
        toggleRepository(repositoryId);
      }
    },
    [expandRepository, toggleRepository],
  );

  const handleCreateWorktreeFrom = useCallback((repositoryId: string) => {
    // TODO: Implement create workspace from repository
    console.log("Create workspace from repository:", repositoryId);
  }, []);

  const handleRefresh = () => {
    // TanStack Query will handle refetching
  };

  const clearError = () => setMutationError(null);

  return (
    <div className="bg-background text-foreground flex h-screen">
      <Sidebar
        repositories={repositories}
        worktreesByRepository={worktreesByRepository}
        selectedWorktreeId={selectedWorktreeId}
        expandedRepositories={new Set(expandedRepositories)}
        isLoading={isLoadingRepositories}
        onAddRepository={handleAddRepository}
        onCloneRepository={() => setShowCloneDialog(true)}
        onCreateWorktree={handleCreateWorktree}
        onCreateWorktreeFrom={handleCreateWorktreeFrom}
        onToggleRepository={handleToggleRepository}
        onSelectWorktree={selectWorktree}
        onArchiveWorktree={(worktreeId, commitFirst) =>
          archiveMutation.mutate({ worktreeId, commitFirst })
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          repository={selectedRepository}
          onRemoveRepository={(repositoryId) => removeRepoMutation.mutate({ repositoryId })}
          onRefresh={handleRefresh}
        />

        <MainContent>
          {selectedWorktree ? (
            <TerminalContainer worktree={selectedWorktree} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <div className="bg-muted mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                <FolderGit2 className="text-muted-foreground h-7 w-7" />
              </div>
              <h2 className="text-foreground mb-1 text-[15px] font-semibold">
                No Worktree Selected
              </h2>
              <p className="text-muted-foreground max-w-xs text-center text-[13px]">
                Select a worktree from the sidebar to open a terminal
              </p>
            </div>
          )}
        </MainContent>
      </div>

      {/* Error toast */}
      {error && (
        <div className="bg-destructive/10 border-destructive/20 text-destructive-foreground animate-in slide-in-from-bottom-2 fixed right-4 bottom-4 flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg">
          <p className="flex-1 pt-0.5 text-[13px]">{error}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive-foreground/70 hover:text-destructive-foreground hover:bg-destructive/10 h-6 w-6 shrink-0"
            onClick={clearError}
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <AddRepositoryDialog
        isOpen={addRepositoryPath !== null}
        path={addRepositoryPath}
        onClose={() => setAddRepositoryPath(null)}
        onAdd={async (path, defaultBranch) => {
          await addRepoMutation.mutateAsync({ path, defaultBranch });
        }}
      />

      <CloneRepositoryDialog
        isOpen={showCloneDialog}
        onClose={() => setShowCloneDialog(false)}
        onClone={async (url, targetPath) => {
          await cloneRepoMutation.mutateAsync({ url, targetPath });
        }}
      />

      <CreateWorktreeDialog
        isOpen={showCreateWorktreeDialog}
        repository={
          createWorktreeRepositoryId
            ? (repositories.find((r) => r.id === createWorktreeRepositoryId) ?? null)
            : null
        }
        onClose={() => {
          setShowCreateWorktreeDialog(false);
          setCreateWorktreeRepositoryId(null);
        }}
        onCreate={async (params) => {
          await createWorktreeMut.mutateAsync(params);
        }}
      />
    </div>
  );
}

export default App;
```

**Step 2: Update Sidebar to use onSelectWorktree**

Edit `apps/desktop/src/renderer/src/components/layout/sidebar.tsx` - change `onViewChanges` to `onSelectWorktree`:

In the interface:

```typescript
interface SidebarProps {
  repositories: Repository[];
  worktreesByRepository: Record<string, Worktree[]>;
  selectedWorktreeId: string | null;
  expandedRepositories: Set<string>;
  isLoading: boolean;
  onAddRepository: () => void;
  onCloneRepository: () => void;
  onCreateWorktree: (repositoryId: string) => void;
  onCreateWorktreeFrom: (repositoryId: string) => void;
  onToggleRepository: (repositoryId: string, open: boolean) => void;
  onSelectWorktree: (worktreeId: string) => void;
  onArchiveWorktree: (worktreeId: string, commitFirst: boolean) => void;
}
```

In the function signature and the worktree button click handler, change `onViewChanges` to `onSelectWorktree`:

```typescript
onClick={() => onSelectWorktree(worktree.id)}
```

**Step 3: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/layout/sidebar.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): integrate terminal into main app
EOF
)"
```

---

## Task 13: Update MainContent for Terminal Layout

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/layout/main-content.tsx`

**Step 1: Remove padding for terminal fullscreen**

```typescript
// apps/desktop/src/renderer/src/components/layout/main-content.tsx
import type { ReactNode } from "react";

interface MainContentProps {
  children: ReactNode;
}

export function MainContent({ children }: MainContentProps) {
  return <main className="bg-background flex-1 overflow-hidden">{children}</main>;
}
```

**Step 2: Verify typecheck**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/layout/main-content.tsx
git commit -m "$(cat <<'EOF'
fix(desktop): remove padding from main content for terminal
EOF
)"
```

---

## Task 14: Test End-to-End

**Step 1: Build the app**

Run: `cd apps/desktop && pnpm build`
Expected: Build succeeds

**Step 2: Run the app in dev mode**

Run: `cd apps/desktop && pnpm dev`
Expected: App launches, sidebar shows worktrees

**Step 3: Manual test checklist**

- [ ] Click a worktree in sidebar → terminal opens in main area
- [ ] Terminal shows shell prompt
- [ ] Type `ls` → see directory listing
- [ ] Click "+" → new terminal tab created
- [ ] Click different tab → switches terminal
- [ ] Click "×" on tab → closes terminal, titles renumber
- [ ] Close last tab → new tab auto-created
- [ ] Switch worktree → previous terminals persist
- [ ] Switch back → terminals still there with history
- [ ] Type `exit` → tab closes

**Step 4: Commit any fixes discovered**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(desktop): terminal integration fixes
EOF
)"
```

---

## Task 15: Cleanup Legacy Store

**Files:**

- Delete: `apps/desktop/src/renderer/src/stores/ui-store.ts`

**Step 1: Remove old ui-store file**

```bash
rm apps/desktop/src/renderer/src/stores/ui-store.ts
```

**Step 2: Verify no import errors**

Run: `cd apps/desktop && pnpm typecheck:web`
Expected: No errors (stores/index.ts exports from app-store)

**Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(desktop): remove legacy ui-store
EOF
)"
```
