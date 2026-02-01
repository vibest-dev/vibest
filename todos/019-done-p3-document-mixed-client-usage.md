---
status: done
priority: p3
issue_id: "019"
tags: [code-review, documentation, architecture]
dependencies: []
---

# Mixed Client Usage Pattern Undocumented

## Problem Statement

The codebase uses two different patterns for IPC calls:

- Direct `client` calls (terminal-view.tsx for write/resize)
- TanStack Query mutations via `orpc` (terminal-tabs.tsx for create/close)

This is intentional (fire-and-forget vs. state-changing operations) but not documented.

## Findings

**Direct client (fire-and-forget):**

- `terminal-view.tsx:82`: `client.terminal.write(...)`
- `terminal-view.tsx:87`: `client.terminal.resize(...)`

**TanStack Query mutations (state-changing):**

- `terminal-tabs.tsx:36`: `useMutation({ ...orpc.terminal.create.mutationOptions() })`

## Proposed Solutions

Add comment explaining the pattern choice.

```typescript
// Use direct client for high-frequency fire-and-forget operations (write, resize)
// that don't need cache invalidation or loading states.
// Use TanStack Query mutations for state-changing operations (create, close)
// that need cache invalidation and optimistic updates.
```

## Acceptance Criteria

- [ ] Comment added explaining pattern
- [ ] Pattern documented in architecture docs (if any)

## Work Log

| Date       | Action                                                                                              | Learnings                          |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 2026-02-01 | Identified via code review                                                                          | Document intentional patterns      |
| 2026-02-01 | Fixed: added inline comment explaining direct client vs TanStack Query pattern in terminal-view.tsx | Pattern documented where it's used |
