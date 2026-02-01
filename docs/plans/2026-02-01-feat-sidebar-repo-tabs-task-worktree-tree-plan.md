---
title: "Sidebar Repo Tabs + Task/Worktree Tree"
type: feat
date: 2026-02-01
---

# Sidebar Repo Tabs + Task/Worktree Tree

## Overview

重构 Sidebar 布局：

1. **顶部 Repo Tabs**: 横向 tag/tab 切换仓库，超出时折叠到下拉菜单
2. **Task 列表**: 显示当前选中 Repo 的 Tasks
3. **Task → Worktree 层级**: 单 worktree 直接显示 Task，多 worktree 可展开收起

```
┌─ Sidebar ───────────────────┐
│ [my-repo] [other] [▼ +2]    │  ← Repo tabs + overflow menu
├─────────────────────────────┤
│ ✓ feat-auth                 │  ← Task (单 worktree，不展开)
│ ▼ fix-bug                   │  ← Task (多 worktree，可展开)
│   └─ 🌿 main                │     └─ Worktree
│   └─ 🌿 experiment          │     └─ Worktree
│   └─ [+]                    │     └─ Add worktree button
│ ▶ refactor-ui               │  ← Task (收起状态)
└─────────────────────────────┘
```

## Problem Statement

当前 Sidebar 是 Repository → Task 的两级结构，但：

1. 切换 Repo 需要展开/收起，不够直观
2. Task 与 Worktree 是 1:1 关系，无法支持一个 Task 多个 Worktree
3. 没有快速切换 Repo 的方式

## Proposed Solution

### 1. Repo Tabs (顶部)

- 使用 `@vibest/ui` 的 `Tabs` 组件
- 显示前 N 个 Repo（根据宽度自适应）
- 超出的 Repo 放入 overflow Menu
- 末尾 `[+]` 按钮添加/克隆仓库

### 2. Task 列表

- 只显示当前选中 Repo 的 Tasks
- 使用 `SidebarMenu` + `SidebarMenuItem`

### 3. Task/Worktree 层级

| 场景                   | 显示                                         |
| ---------------------- | -------------------------------------------- |
| Task 有 0 个 worktree  | 显示 Task，无展开箭头                        |
| Task 有 1 个 worktree  | 显示 Task，无展开箭头，点击直接打开 worktree |
| Task 有 2+ 个 worktree | 显示 Task + 展开箭头，展开显示 worktree 列表 |

## Technical Approach

### 状态管理

新增 `selectedRepositoryId` 到 store:

```typescript
// stores/slices/workspace-slice.ts
export interface WorkspaceSlice {
  selectedRepositoryId: string | null;
  selectRepository: (id: string | null) => void;
  // ... existing
}
```

新增 `expandedTaskIds` 到 task slice:

```typescript
// stores/slices/task-slice.ts
export interface TaskSlice {
  selectedTaskId: string | null;
  expandedTaskIds: string[]; // NEW: 展开的 Task IDs
  selectTask: (id: string | null) => void;
  toggleTaskExpanded: (id: string) => void; // NEW
  // ... existing
}
```

### 组件结构

```
Sidebar
├── RepoTabs (NEW)
│   ├── TabsList (横向 tabs)
│   │   ├── RepoTab × N (可见的)
│   │   └── OverflowMenu (超出的 repos)
│   └── AddRepoButton
├── TaskList
│   └── TaskItem (for each task)
│       ├── TaskHeader (可点击展开/收起)
│       └── WorktreeList (Collapsible)
│           ├── WorktreeItem × N
│           └── AddWorktreeButton [+]
└── EmptyState (无 Task 时)
```

### 文件改动

| 文件                                  | 改动                        |
| ------------------------------------- | --------------------------- |
| `components/layout/sidebar.tsx`       | 重构，添加 RepoTabs         |
| `components/layout/repo-tabs.tsx`     | **NEW**: Repo 切换 tabs     |
| `components/layout/task-item.tsx`     | **NEW**: Task 展开/收起逻辑 |
| `components/layout/worktree-item.tsx` | **NEW**: Worktree 行        |
| `stores/slices/workspace-slice.ts`    | 添加 `selectedRepositoryId` |
| `stores/slices/task-slice.ts`         | 添加 `expandedTaskIds`      |
| `App.tsx`                             | 适配新的 Sidebar props      |

## Acceptance Criteria

### Functional

- [ ] 顶部显示 Repo tabs，可点击切换
- [ ] 超过可显示数量的 Repo 折叠到 overflow menu
- [ ] 点击 `[+]` 可添加/克隆仓库
- [ ] Task 列表只显示当前选中 Repo 的 Tasks
- [ ] 单 worktree 的 Task 点击直接打开 terminal
- [ ] 多 worktree 的 Task 点击展开/收起
- [ ] 展开后显示 worktree 列表
- [ ] 展开后底部有 `[+]` 按钮添加 worktree
- [ ] 选中状态正确高亮

### Non-Functional

- [ ] Repo tabs 响应式适配
- [ ] 动画流畅（展开/收起）
- [ ] 状态持久化（selectedRepositoryId, expandedTaskIds）

## Implementation Phases

### Phase 1: 状态基础

1. 添加 `selectedRepositoryId` 到 workspace slice
2. 添加 `expandedTaskIds` 到 task slice
3. 更新 App.tsx 使用新状态

### Phase 2: RepoTabs 组件

1. 创建 `repo-tabs.tsx` 组件
2. 实现基础 tabs 切换
3. 实现 overflow menu

### Phase 3: Task/Worktree 层级

1. 重构 Sidebar 移除 Repository 层级
2. 创建 `task-item.tsx` 支持展开/收起
3. 创建 `worktree-item.tsx`
4. 实现添加 worktree 功能

### Phase 4: 完善交互

1. 添加动画效果
2. 状态持久化
3. 键盘导航支持

## References

### 现有组件

- `packages/ui/src/components/tabs.tsx` - 可复用的 Tabs 组件
- `packages/ui/src/components/collapsible.tsx` - 展开收起
- `packages/ui/src/components/sidebar.tsx` - SidebarMenu\* 组件

### 现有代码

- `apps/desktop/src/renderer/src/components/layout/sidebar.tsx:54-66` - 当前 Props
- `apps/desktop/src/renderer/src/stores/slices/task-slice.ts:1-30` - Task 状态
- `apps/desktop/src/shared/types.ts:30-70` - Task/Worktree 类型

## Open Questions

1. **添加 Worktree Dialog**: 需要新建还是复用现有组件？
2. **持久化范围**: selectedRepositoryId 是否需要持久化到磁盘？
3. **空 Repo 处理**: 没有 Task 的 Repo 显示什么？
