# Remote Worktree Support

**Date:** 2026-02-01
**Status:** Brainstorm Complete

## What We're Building

Enable creating and operating Git Worktrees on remote machines (SSH servers, Docker containers) to support distributed development workflows.

### Core Concept

**Repo-centric with distributed Worktrees**:

```
GitHub Repo (unique identifier)
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

- **Repo** is a logical concept, identified by GitHub URL
- **Worktree** is a physical implementation, bound to a specific machine
- Worktrees of the same Repo can be distributed across any machine

### Prerequisites for Remote Features

- **GitHub URL is NOT required for all repos**
- **But remote features require a GitHub URL**
- Reason: Remote machines need to clone the same repository, requiring a remotely accessible URL

```
Local-only Repo      → GitHub URL optional
Remote-enabled Repo  → GitHub URL required
```

## Why This Approach

### User Scenarios

1. **SSH Dev Servers**: Run development environment on Linux servers
2. **Docker Containers**: Isolated development environments

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remote Dependencies | SSH only | No agent installation required, lower barrier to entry |
| Core Identifier | GitHub URL | Global unique identifier for repo, enables cross-machine sync |
| Operation Scope | Full functionality | Remote supports all local operations: git, terminal, worktree management |

### Recommended Implementation

**Backend Abstraction Layer (Executor Pattern)**:

```
Worktree
    ↓
Executor (selected by machine.type)
    ├── LocalExecutor  → Direct execution
    ├── SSHExecutor    → Execute via ssh2 library
    └── DockerExecutor → Execute via dockerode
```

Benefits:
- Service layer code remains mostly unchanged
- Incremental implementation: local first, then SSH/Docker
- Complies with "SSH only" constraint

## Key Decisions

1. **GitHub URL is the gateway to remote features**, not a mandatory requirement
2. **Repo is the core dimension**, Worktree is bound to Machine
3. **Remote machines only need SSH access**, no agent installation required
4. **All local features supported remotely**: git operations, terminal, worktree management
5. **Adding Repo supports two methods**: new clone or link existing directory

## Main Flows

### Flow 1: Add Repo

1. User enters GitHub URL (optional)
2. Select machine (local or remote)
3. Clone or link existing directory
4. Repo added successfully

### Flow 2: Create Remote Worktree

1. Select Repo (must have GitHub URL)
2. Select target machine (SSH/Docker)
3. If remote has no clone → clone first
4. Execute `git worktree add`

### Flow 3: Operate Worktree

Route to correct Executor based on worktree's machine:
- git status / diff / fetch / pull
- Open terminal
- Switch/delete/archive worktree

## Open Questions

1. **SSH Key Management**: Use system ssh-agent or in-app management?
2. **Connection Status**: Reconnection strategy? How to display UI when offline?
3. **Future Sync**: How to sync Repo config across devices? (GitHub Gist? Cloud storage?)
4. **Docker Scenario**: Connect to local Docker or remote Docker Daemon?

## Next Steps

1. Run `/workflows:plan` to design detailed implementation
2. Implement Executor abstraction layer + LocalExecutor first
3. Then implement SSHExecutor
4. Finally implement DockerExecutor
