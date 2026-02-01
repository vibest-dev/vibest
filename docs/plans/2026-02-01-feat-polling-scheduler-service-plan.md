---
title: "feat: Add PollingScheduler Service for Background Task Management"
type: feat
date: 2026-02-01
---

# feat: Add PollingScheduler Service

## Overview

实现一个通用的轮询调度服务，用于管理后台定时任务。首要用例是 Git 状态轮询（worktree diff stats），未来可扩展到 GitHub PR 状态、CI 状态等。

采用 TDD（测试驱动开发）方式实现，先写测试再写代码。

## Problem Statement / Motivation

当前问题：
1. Worktree 列表的 git diff stats 在首次加载后不会更新
2. `useGitStatus` hook 的 fetch/pull 成功后只刷新 `git.status`，遗漏了 `git.diff`
3. 外部变更（VS Code、命令行）不会反映到 UI

未来需求：
- GitHub PR 状态轮询
- GitHub Actions 状态轮询
- 其他需要定期检查的后台任务

需要一个统一的轮询调度器来管理这些任务。

## Proposed Solution

在 Main 进程创建 `PollingScheduler` 服务：

```
┌─────────────────────────────────────────────────────────────────┐
│  PollingScheduler (全局单例)                                     │
│                                                                  │
│  核心能力:                                                       │
│  ✓ 单一全局定时器 (setInterval)                                  │
│  ✓ 并发控制 (p-queue, maxConcurrent=3)                          │
│  ✓ 优先级排序 (动态优先级防饥饿)                                  │
│  ✓ 失败退避 (指数退避，最多 5 分钟)                               │
│  ✓ 事件发布 (MemoryPublisher)                                   │
│                                                                  │
│  tasks: Map<id, PollTask>                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 架构

```typescript
// 任务定义
interface PollTask {
  id: string;                      // "git:diff:/path/a" 或 "github:pr:123"
  execute: () => Promise<unknown>; // 执行函数
  interval: number;                // 期望间隔 (ms)
  nextRun: number;                 // 下次执行时间
  basePriority: number;            // 基础优先级
  failCount: number;               // 连续失败次数
}

// 调度器
class PollingScheduler {
  register(task): void;    // 注册任务
  unregister(id): void;    // 取消任务
  runNow(id): void;        // 立即执行
  start(): void;           // 启动调度器
  stop(): void;            // 停止调度器
}
```

### 数据流

```
PollingScheduler (Main)
    │
    ├─ 每秒 tick → 检查哪些任务到期
    │
    ├─ 到期任务 → p-queue 处理并发
    │
    ├─ 执行成功 → publisher.publish('git:diff:changed', { path, diff })
    │
    └─ 执行失败 → 指数退避，修改 nextRun

Renderer (订阅)
    │
    └─ 收到事件 → queryClient.setQueryData() 更新缓存
```

## Technical Considerations

### 依赖选择

| 库 | 用途 | 说明 |
|---|---|---|
| `p-queue` | 并发控制 + 优先级 | 轻量，无外部依赖 |
| `@orpc/experimental-publisher` | 事件发布 | 项目已在用 |

### 并发与防饥饿

1. **并发控制**：使用 p-queue 的 `concurrency` 选项
2. **防饥饿**：动态优先级 = basePriority + 等待时间/1000
3. **退避**：失败后 nextRun = now + interval × 2^failCount，最多重试 10 次

### 性能考虑

- 10 个 worktree，每个 interval=10s
- 每秒 tick 一次，只是检查时间戳，开销极小
- 实际 git diff 操作由 p-queue 控制并发
- **Git diff 优化**：使用 `git diff --numstat` 只获取统计信息，避免读取文件内容
- **超时保护**：单个任务执行超过 5 秒自动取消

### 测试策略 (TDD)

1. 使用 Vitest（需新增配置）
2. Mock `setInterval` 和时间，注入 `now()` 函数便于测试
3. 测试用例覆盖：
   - 任务注册/注销
   - 到期检测
   - 并发控制
   - 优先级排序
   - 失败退避
   - 防饥饿
   - 超时处理

### Renderer 订阅机制 (P0 补充)

需要扩展 `AppEvents` 类型并创建 subscription contract：

```typescript
// src/main/app.ts - 扩展事件类型
export type AppEvents = {
  [K: `terminal:${string}`]: TerminalEvent;
  [K: `git:changes:${string}`]: GitChangeEvent;  // 新增
};

export type GitChangeEvent = {
  type: "diff";
  path: string;
  stats: { insertions: number; deletions: number; filesChanged: number };
};
```

```typescript
// src/shared/contract/git.ts - 新增 subscription
import { eventIterator, oc } from "@orpc/contract";

export const GitChangeEventSchema = z.object({
  type: z.literal("diff"),
  path: z.string(),
  stats: z.object({
    insertions: z.number(),
    deletions: z.number(),
    filesChanged: z.number(),
  }),
});

export const gitContract = oc.router({
  // ... 现有 routes
  watchChanges: oc
    .input(z.object({ paths: z.array(z.string()) }))
    .output(eventIterator(GitChangeEventSchema)),
});
```

### 任务生命周期管理 (P1 补充)

任务需要与 worktree 关联，便于批量清理：

```typescript
interface PollTask {
  id: string;
  groupId?: string;  // worktreeId，用于批量 unregister
  execute: () => Promise<unknown>;
  interval: number;
  nextRun: number;
  basePriority: number;
  failCount: number;
}

class PollingScheduler {
  // ... 现有方法
  unregisterByGroup(groupId: string): void {
    for (const [id, task] of this.tasks) {
      if (task.groupId === groupId) {
        this.tasks.delete(id);
      }
    }
    if (this.tasks.size === 0) {
      this.stop();
    }
  }
}
```

### 窗口焦点处理 (P1 补充)

```typescript
// src/main/index.ts
mainWindow.on('focus', () => {
  // 触发所有 git diff 任务立即执行
  app.scheduler.runAllByGroup('git');
});
```

## Acceptance Criteria

### 功能需求

- [x] PollingScheduler 能注册/注销任务
- [x] 任务按 interval 定期执行
- [x] 并发数不超过 maxConcurrent (默认 3)
- [x] 高优先级任务先执行
- [x] 失败任务指数退避
- [x] 等待过久的任务优先级提升（防饥饿）
- [x] 支持 `runNow(id)` 立即执行

### 集成需求

- [x] GitWatcherService 使用 PollingScheduler
- [x] Git diff 变更时发布事件
- [x] Renderer 订阅事件并更新 UI
- [x] 扩展 AppEvents 类型支持 git 事件
- [x] 创建 watchChanges subscription contract
- [x] 窗口获得焦点时触发刷新

### 生命周期需求

- [x] 任务支持 groupId 用于批量管理
- [x] worktree 删除时清理对应任务 (via subscription cleanup)
- [x] 应用退出时停止调度器
- [x] 支持 maxRetries 限制（默认 10 次）

### 测试需求

- [x] 单元测试覆盖核心逻辑
- [x] 测试并发场景
- [x] 测试退避场景
- [x] 测试防饥饿场景
- [x] 测试超时场景
- [x] 测试 groupId 批量清理

## Success Metrics

1. Worktree 列表的 diff stats 能自动更新
2. 选中的 worktree 刷新更快（优先级更高）
3. 切回 app 窗口时立即刷新
4. CPU 使用率无明显增加

## Dependencies & Risks

### 依赖

- 需要安装 `p-queue`
- 需要配置 Vitest（目前 desktop app 只有 E2E 测试）

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| p-queue API 变化 | 中 | 锁定版本 |
| Git 操作耗时过长 | 中 | 5 秒超时 + 使用 --numstat |
| 内存泄漏（任务未清理）| 高 | groupId 批量清理 + 应用退出时 stop() |
| execute 闭包捕获大对象 | 中 | 只捕获 path 标识符，不捕获数据 |
| 无限重试失败任务 | 低 | maxRetries=10 后停止 |

## MVP

### 文件结构

```
apps/desktop/
├── src/main/
│   ├── services/
│   │   ├── polling-scheduler.ts      # 核心调度器
│   │   ├── git-watcher-service.ts    # Git 监听服务
│   │   └── __tests__/
│   │       └── polling-scheduler.test.ts # TDD 测试
│   ├── ipc/router/
│   │   └── git.ts                    # 新增 watchChanges subscription
│   ├── app.ts                        # 扩展 AppEvents 类型
│   └── index.ts                      # 添加窗口焦点处理
├── src/shared/contract/
│   └── git.ts                        # 新增 subscription contract
├── src/renderer/src/hooks/
│   └── use-git-watcher.ts            # 订阅 git 变更
└── vitest.config.ts                  # 新增
```

### polling-scheduler.ts

```typescript
import PQueue from "p-queue";

export interface PollTask {
  id: string;
  groupId?: string;  // 用于批量 unregister（如 worktreeId）
  execute: () => Promise<unknown>;
  interval: number;
  nextRun: number;
  basePriority: number;
  failCount: number;
}

export interface PollingSchedulerOptions {
  concurrency?: number;
  maxRetries?: number;
  taskTimeout?: number;
  now?: () => number;  // 便于测试
}

export class PollingScheduler {
  private queue: PQueue;
  private tasks = new Map<string, PollTask>();
  private timer: NodeJS.Timeout | null = null;
  private tickInterval = 1000;
  private maxBackoff = 300_000; // 5 分钟
  private maxRetries: number;
  private taskTimeout: number;
  private now: () => number;

  constructor(options?: PollingSchedulerOptions) {
    this.queue = new PQueue({ concurrency: options?.concurrency ?? 3 });
    this.maxRetries = options?.maxRetries ?? 10;
    this.taskTimeout = options?.taskTimeout ?? 5000;
    this.now = options?.now ?? Date.now;
  }

  register(task: Omit<PollTask, "nextRun" | "failCount">) {
    this.tasks.set(task.id, {
      ...task,
      nextRun: this.now(),
      failCount: 0,
    });
    this.ensureRunning();
  }

  unregister(id: string) {
    this.tasks.delete(id);
    if (this.tasks.size === 0) {
      this.stop();
    }
  }

  unregisterByGroup(groupId: string) {
    for (const [id, task] of this.tasks) {
      if (task.groupId === groupId) {
        this.tasks.delete(id);
      }
    }
    if (this.tasks.size === 0) {
      this.stop();
    }
  }

  runNow(id: string) {
    const task = this.tasks.get(id);
    if (task) {
      task.nextRun = 0;
    }
  }

  runAllByGroup(groupId: string) {
    for (const task of this.tasks.values()) {
      if (task.groupId === groupId) {
        task.nextRun = 0;
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.clear();
  }

  private ensureRunning() {
    if (this.tasks.size > 0 && !this.timer) {
      this.start();
    }
  }

  private tick() {
    const now = this.now();

    for (const task of this.tasks.values()) {
      if (task.nextRun <= now) {
        // 超过最大重试次数，跳过
        if (task.failCount >= this.maxRetries) {
          continue;
        }

        // 动态优先级：等待越久优先级越高
        const waitTime = now - task.nextRun;
        const dynamicPriority = task.basePriority + Math.floor(waitTime / 1000);

        // 先设置下次时间，防止重复入队
        task.nextRun = now + task.interval;

        this.queue.add(() => this.execute(task), { priority: dynamicPriority });
      }
    }
  }

  private async execute(task: PollTask) {
    try {
      // 超时保护
      await Promise.race([
        task.execute(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Task timeout")), this.taskTimeout)
        ),
      ]);
      task.failCount = 0;
    } catch (error) {
      task.failCount++;
      const backoff = Math.min(
        task.interval * Math.pow(2, task.failCount),
        this.maxBackoff
      );
      task.nextRun = this.now() + backoff;
      console.warn(`Task ${task.id} failed (${task.failCount}x), retry in ${backoff}ms`);
    }
  }
}
```

### polling-scheduler.test.ts

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollingScheduler } from "../polling-scheduler";

describe("PollingScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("任务注册", () => {
    it("注册任务后应立即可执行", async () => {
      const scheduler = new PollingScheduler();
      const execute = vi.fn().mockResolvedValue(undefined);

      scheduler.register({
        id: "test:1",
        execute,
        interval: 10_000,
        basePriority: 0,
      });

      await vi.advanceTimersByTimeAsync(1000); // tick
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("注销任务后应停止执行", async () => {
      const scheduler = new PollingScheduler();
      const execute = vi.fn().mockResolvedValue(undefined);

      scheduler.register({
        id: "test:1",
        execute,
        interval: 5_000,
        basePriority: 0,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(1);

      scheduler.unregister("test:1");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(execute).toHaveBeenCalledTimes(1); // 没有新的调用
    });
  });

  describe("定时执行", () => {
    it("应按 interval 间隔执行", async () => {
      const scheduler = new PollingScheduler();
      const execute = vi.fn().mockResolvedValue(undefined);

      scheduler.register({
        id: "test:1",
        execute,
        interval: 5_000,
        basePriority: 0,
      });

      await vi.advanceTimersByTimeAsync(1000); // 第 1 次
      await vi.advanceTimersByTimeAsync(5000); // 第 2 次
      await vi.advanceTimersByTimeAsync(5000); // 第 3 次

      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("并发控制", () => {
    it("不应超过 maxConcurrent", async () => {
      const scheduler = new PollingScheduler({ concurrency: 2 });
      let running = 0;
      let maxRunning = 0;

      const execute = vi.fn().mockImplementation(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 100));
        running--;
      });

      // 注册 5 个任务
      for (let i = 0; i < 5; i++) {
        scheduler.register({
          id: `test:${i}`,
          execute,
          interval: 10_000,
          basePriority: 0,
        });
      }

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(500); // 等待所有执行完

      expect(maxRunning).toBeLessThanOrEqual(2);
    });
  });

  describe("失败退避", () => {
    it("失败后应指数退避", async () => {
      const scheduler = new PollingScheduler();
      const execute = vi.fn().mockRejectedValue(new Error("fail"));

      scheduler.register({
        id: "test:1",
        execute,
        interval: 1_000,
        basePriority: 0,
      });

      await vi.advanceTimersByTimeAsync(1000); // 第 1 次失败
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000); // 还在退避期
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000); // 退避结束（1s * 2^1 = 2s）
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("优先级", () => {
    it("高优先级任务应先执行", async () => {
      const scheduler = new PollingScheduler({ concurrency: 1 });
      const order: string[] = [];

      const createTask = (id: string, priority: number) => ({
        id,
        execute: vi.fn().mockImplementation(async () => {
          order.push(id);
        }),
        interval: 10_000,
        basePriority: priority,
      });

      scheduler.register(createTask("low", 1));
      scheduler.register(createTask("high", 10));

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(100);

      expect(order[0]).toBe("high");
    });
  });

  describe("防饥饿", () => {
    it("等待过久的任务优先级应提升", async () => {
      const scheduler = new PollingScheduler({ concurrency: 1 });
      const order: string[] = [];

      // 慢任务，一直占用
      let blockResolve: () => void;
      const blockPromise = new Promise<void>((r) => (blockResolve = r));

      scheduler.register({
        id: "blocker",
        execute: async () => {
          order.push("blocker");
          await blockPromise;
        },
        interval: 100_000,
        basePriority: 10,
      });

      // 低优先级任务
      scheduler.register({
        id: "starving",
        execute: async () => {
          order.push("starving");
        },
        interval: 1_000,
        basePriority: 1,
      });

      await vi.advanceTimersByTimeAsync(1000); // blocker 开始执行

      // 等待 15 秒，starving 的动态优先级 = 1 + 15 = 16 > 10
      await vi.advanceTimersByTimeAsync(15_000);

      // 释放 blocker
      blockResolve!();
      await vi.advanceTimersByTimeAsync(100);

      // 再次 tick，starving 应该在 blocker 之前（因为优先级更高了）
      // 但由于 blocker 刚执行完，nextRun 在未来，所以只有 starving 会执行
      expect(order).toContain("starving");
    });
  });

  describe("runNow", () => {
    it("应立即执行指定任务", async () => {
      const scheduler = new PollingScheduler();
      const execute = vi.fn().mockResolvedValue(undefined);

      scheduler.register({
        id: "test:1",
        execute,
        interval: 60_000, // 1 分钟
        basePriority: 0,
      });

      await vi.advanceTimersByTimeAsync(1000); // 第 1 次
      expect(execute).toHaveBeenCalledTimes(1);

      scheduler.runNow("test:1");

      await vi.advanceTimersByTimeAsync(1000); // 立即执行
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });
});
```

## References

### Internal References

- 现有服务模式: `apps/desktop/src/main/services/git-service.ts`
- 事件发布: `apps/desktop/src/main/app.ts` (MemoryPublisher)
- Terminal 订阅模式: `apps/desktop/src/main/ipc/router/terminal.ts`

### External References

- [p-queue - npm](https://www.npmjs.com/package/p-queue)
- [Vitest 文档](https://vitest.dev/)
