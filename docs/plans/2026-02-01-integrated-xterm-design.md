# Integrated xterm Terminal Design

## Overview

为 Electron desktop app 添加集成终端功能。每个 git worktree 拥有独立的终端 tabs，切换 worktree 时终端保持运行。

## Architecture

### Main Process

#### TerminalManager

管理所有 PTY 实例的生命周期。

```typescript
// apps/desktop/src/main/terminal/terminal-manager.ts

interface TerminalInstance {
  id: string;
  worktreeId: string;
  pty: IPty;
  title: string;
}

class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();

  create(worktreeId: string, cwd: string): string;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  getTerminalsByWorktree(worktreeId: string): TerminalInstance[];
  dispose(): void;
}
```

**PTY 配置 (node-pty):**

```typescript
import * as pty from "node-pty";
import * as os from "node:os";

const shell = os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "bash";

const ptyProcess = pty.spawn(shell, [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: worktreePath,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  },
});
```

#### TerminalService

处理 IPC 通信，桥接 renderer 和 TerminalManager。

```typescript
// apps/desktop/src/main/terminal/terminal-service.ts

class TerminalService {
  constructor(private manager: TerminalManager) {}

  // 注册 IPC handlers
  registerHandlers(): void;
}
```

### IPC Contract

```typescript
// apps/desktop/src/shared/contract/terminal.ts

export const terminalContract = {
  create: base
    .input(
      z.object({
        worktreeId: z.string(),
        cwd: z.string(),
      }),
    )
    .output(
      z.object({
        terminalId: z.string(),
      }),
    ),

  write: base.input(
    z.object({
      terminalId: z.string(),
      data: z.string(),
    }),
  ),

  resize: base.input(
    z.object({
      terminalId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }),
  ),

  close: base.input(
    z.object({
      terminalId: z.string(),
    }),
  ),

  list: base
    .input(
      z.object({
        worktreeId: z.string(),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          title: z.string(),
        }),
      ),
    ),
};

// Data event: main → renderer (via IPC channel)
// Channel: 'terminal:data:{terminalId}'
// Payload: string (output data)

// Exit event: main → renderer
// Channel: 'terminal:exit:{terminalId}'
// Payload: { exitCode: number }
```

### Renderer Process

#### Store (Zustand)

单一 store，多个 slice：

```typescript
// apps/desktop/src/renderer/stores/app-store.ts

interface WorkspaceSlice {
  selectedWorktreeId: string | null;
  setSelectedWorktreeId: (id: string | null) => void;
}

interface TerminalSlice {
  // 每个 worktree 的 active terminal id
  activeTerminalId: Record<string, string | null>;
  setActiveTerminalId: (worktreeId: string, terminalId: string | null) => void;
}

type AppStore = WorkspaceSlice & TerminalSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createTerminalSlice(...a),
}));
```

**Terminal 列表数据** 通过 TanStack Query 从 main 进程获取，保持与现有架构一致。

#### Components

```
src/renderer/components/terminal/
├── terminal-tabs.tsx      # Tab bar with add/close buttons
├── terminal-view.tsx      # xterm.js instance wrapper
└── terminal-container.tsx # Manages multiple TerminalView instances
```

**TerminalView (xterm.js 配置):**

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontSize: 14,
  fontFamily: "JetBrains Mono, Menlo, Monaco, monospace",
  fontWeight: "normal",
  lineHeight: 1.2,
  scrollback: 5000,
  theme: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#ffffff",
    selectionBackground: "#264f78",
    // ... full color palette
  },
});

// Addons
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

// WebGL for performance (with fallback)
try {
  const webglAddon = new WebglAddon();
  webglAddon.onContextLoss(() => webglAddon.dispose());
  terminal.loadAddon(webglAddon);
} catch (e) {
  console.warn("WebGL addon failed, using canvas renderer");
}

// Auto-fit on container resize
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
});
resizeObserver.observe(container);

// Sync resize to PTY
terminal.onResize(({ cols, rows }) => {
  ipc.terminal.resize({ terminalId, cols, rows });
});

// Handle user input
terminal.onData((data) => {
  ipc.terminal.write({ terminalId, data });
});

// Receive PTY output
ipcRenderer.on(`terminal:data:${terminalId}`, (_, data) => {
  terminal.write(data);
});

// Handle PTY exit
ipcRenderer.on(`terminal:exit:${terminalId}`, (_, { exitCode }) => {
  // Close tab, trigger "at least one" logic
});
```

**Terminal 实例保持存活：** 切换 worktree 时，通过 CSS `display: none` 隐藏非活动终端，而不是卸载组件，以保留滚动历史和 PTY 连接。

## UI Behavior

### Tab Management

- **Tab 标题：**
  - 1 个 Tab → 显示 `Terminal`
  - 多个 Tab → 显示 `Terminal 1`, `Terminal 2`, ...
  - 关闭后序号重排

- **新建 Tab：** 点击 "+" 按钮，`cwd` 设为当前 worktree path

- **关闭 Tab：** 点击 "×" 按钮
  - 关闭最后一个时自动新建一个

- **Shell 退出：** 用户输入 `exit` 或 PTY 崩溃时关闭该 Tab

### Sidebar Integration

点击 sidebar 中的 worktree → 主区域显示该 worktree 的终端 tabs。

切换 worktree 时，之前的终端继续在后台运行。

## Dependencies

**Main Process:**

- `node-pty` - PTY management

**Renderer Process:**

- `@xterm/xterm` - Terminal emulator
- `@xterm/addon-fit` - Auto-resize
- `@xterm/addon-webgl` - GPU acceleration (optional, with fallback)

## File Structure

```
apps/desktop/src/
├── main/
│   ├── terminal/
│   │   ├── terminal-manager.ts
│   │   └── terminal-service.ts
│   └── ipc/router/
│       └── terminal.ts
├── renderer/
│   ├── components/terminal/
│   │   ├── terminal-tabs.tsx
│   │   ├── terminal-view.tsx
│   │   └── terminal-container.tsx
│   └── stores/
│       └── app-store.ts  # 重构：合并 workspace + terminal slices
└── shared/
    └── contract/
        └── terminal.ts
```

## Migration Notes

现有 `useSelectedStore` 将合并到新的 `useAppStore`，使用 slice 模式组织。

## Error Handling

- **PTY spawn 失败：** 显示错误提示，不创建 Tab
- **WebGL context loss：** 自动 dispose 并降级到 canvas renderer
- **IPC 通信失败：** 显示重连提示或关闭 Tab
- **Shell 异常退出：** 关闭 Tab，触发 "至少保留一个" 逻辑

## Future Enhancements (Out of Scope)

- 键盘快捷键 (Cmd+T, Cmd+W, Cmd+Shift+[/])
- Tab 重命名
- 分屏显示
- 搜索功能
- 与 AI chat 集成
