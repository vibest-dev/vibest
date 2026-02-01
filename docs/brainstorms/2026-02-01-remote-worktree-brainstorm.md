# Remote Worktree Support

**Date:** 2026-02-01
**Status:** Brainstorm Complete

## What We're Building

支持在远程机器（SSH 服务器、Docker 容器）上创建和操作 Git Worktree，实现分布式开发工作流。

### 核心概念

**以 Repo 为中心，Worktree 分布式**：

```
GitHub Repo (唯一标识)
    │
    ├── Machine: MacBook (local)
    │   ├── Worktree: main
    │   └── Worktree: feature-x
    │
    ├── Machine: Dev Server (ssh)
    │   └── Worktree: hotfix
    │
    └── Machine: Docker Container
        └── Worktree: experiment
```

- **Repo** 是逻辑概念，通过 GitHub URL 标识
- **Worktree** 是物理实现，绑定到具体机器
- 同一个 Repo 的 Worktree 可以分布在任意机器上

### 远程功能的前提条件

- **GitHub URL 不是所有 repo 的强制要求**
- **但想要远程功能，必须有 GitHub URL**
- 原因：远程机器需要 clone 同一个仓库，需要一个远程可访问的 URL

```
纯本地 Repo       → GitHub URL 可选
支持远程的 Repo   → GitHub URL 必须
```

## Why This Approach

### 用户场景

1. **SSH 开发服务器**：在 Linux 服务器上运行开发环境
2. **Docker 容器**：隔离的开发环境

### 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 远程依赖 | 仅需 SSH | 无需在远程安装 agent，降低使用门槛 |
| 核心标识 | GitHub URL | 作为 repo 的全局唯一标识，支持跨机器同步 |
| 操作范围 | 完整功能 | 远程支持所有本地操作：git、终端、worktree 管理 |

### 推荐实现方案

**Backend 抽象层（Executor 模式）**：

```
Worktree
    ↓
Executor (根据 machine.type 选择)
    ├── LocalExecutor  → 直接执行
    ├── SSHExecutor    → ssh2 库执行
    └── DockerExecutor → dockerode 执行
```

优点：
- Service 层代码基本不变
- 渐进式实现，先 local，再加 SSH/Docker
- 符合"仅 SSH"约束

## Key Decisions

1. **GitHub URL 是远程功能的门槛**，不是强制要求
2. **以 Repo 为核心维度**，Worktree 绑定到 Machine
3. **远程机器仅需 SSH 访问**，无需安装任何 agent
4. **所有本地功能都支持远程**：git 操作、终端、worktree 管理
5. **添加 Repo 支持两种方式**：新 clone 或关联现有目录

## Main Flows

### Flow 1: 添加 Repo

1. 用户输入 GitHub URL（可选）
2. 选择机器（本地或远程）
3. Clone 或关联已有目录
4. Repo 添加成功

### Flow 2: 创建远程 Worktree

1. 选择 Repo（必须有 GitHub URL）
2. 选择目标机器（SSH/Docker）
3. 如果远程没有 clone → 先 clone
4. 执行 `git worktree add`

### Flow 3: 操作 Worktree

根据 worktree 所在机器，自动路由到正确的 Executor：
- git status / diff / fetch / pull
- 打开终端
- 切换/删除/归档 worktree

## Open Questions

1. **SSH 密钥管理**：使用系统 ssh-agent 还是应用内管理？
2. **连接状态**：断线重连策略？离线时 UI 如何展示？
3. **未来同步**：Repo 配置如何跨设备同步？（GitHub Gist？云存储？）
4. **Docker 场景**：连接本地 Docker 还是远程 Docker Daemon？

## Next Steps

1. 运行 `/workflows:plan` 设计详细实现方案
2. 先实现 Executor 抽象层 + LocalExecutor
3. 再实现 SSHExecutor
4. 最后实现 DockerExecutor
