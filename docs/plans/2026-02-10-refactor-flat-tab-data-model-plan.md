---
title: "refactor: Flat Tab Data Model for Split Panes"
type: refactor
date: 2026-02-10
brainstorm: docs/brainstorms/2026-02-09-flat-tab-data-model-brainstorm.md
deepened: 2026-02-10
---

## Enhancement Summary

**Deepened on:** 2026-02-10
**Research agents used:** TypeScript reviewer, Pattern recognition specialist, Performance oracle, Frontend races reviewer, Architecture strategist, Code simplicity reviewer, Zustand best practices, React composition patterns, React performance patterns

### Critical Findings

1. **[BUG] TabBar hooks-in-loop violation** — The brainstorm's TabBar code calls `useAppStore` inside `.map()`, violating Rules of Hooks. Extract `TabBarItem` as a child component. (React composition patterns agent)
2. **[RACE] Central operation state machine needed** — 3 high-severity race conditions identified: `resetTabs` + `openDiff` interleave, `switchWorktree` double-fire, `toggleSecondarySplit` + open. Add a single `operationState` guard (~20 lines). (Frontend races reviewer)
3. **[RACE] `openDiff` TOCTOU dedup** — Concurrent `openDiff` for the same file can bypass the dedup check and orphan a View instance. Use atomic check-and-reserve via `set()`. (Frontend races reviewer)
4. **[NAME] `TerminalView` collision** — Existing React component `terminal-view.tsx` exports `TerminalView`. The planned lifecycle class cannot share this name. Rename one. (Pattern recognition specialist)
5. **[CLEANUP] Defensive `view.close()` in error path** — If `view.open()` partially succeeds (PTY created but response parse fails), the View holds a `terminalId` but is never bound. Call `view.close()` in catch block. (Frontend races reviewer, Architecture strategist)
6. **[SIMPLICITY] Consider dropping `hookable` dependency** — With only two View implementations and hooks called at well-defined framework points, plain method calls (`onCreated()`, `onBeforeClose()`) suffice. Save a dependency. (Frontend races reviewer, Code simplicity reviewer)

### Key Improvements Added

- Operation state machine for async action safety
- TabBarItem extraction for hooks correctness + render performance
- Naming collision resolution guidance
- Error handling hardening for partial `open()` failures
- Zustand slices pattern confirmed compatible (Context7 docs)
- `isActive` guard for nested rAF in terminal-view.tsx

# refactor: Flat Tab Data Model for Split Panes

## Overview

Unify the desktop app's two-layer tab management (split-level categories in `split-state.ts` + module-level internal tabs in `TerminalPanel`) into an Obsidian-inspired Workbench / Split / View architecture.

**Workbench** manages Splits, registers View types, and provides global operations. **Split** manages Views within a pane (tab bar is a rendering detail). **View** is a per-view lifecycle instance managing backend resources. The Zustand store holds the serialized projection (`WorkbenchState`) for React to read.

This eliminates duplicated tab logic, enables multiple views of the same kind per split, provides a plugin-friendly API (`workbench.registerView`, `split.setViewState`), and removes ~200 lines of handler code from `App.tsx`.

## Problem Statement

The current system has two separate tab management layers:

1. **Split-level tabs** (`PaneLeaf[]` in `split-state.ts`) — Terminal and Diff as fixed categories, one per kind per split, with IDs like `"${splitId}:${kind}"`
2. **Module-level tabs** (`TerminalPanel` + TanStack Query + `TerminalSlice`) — individual terminal instances managed internally with their own tab bar, create/close logic, and active selection

This creates:
- Duplicated tab logic (close, activate, create in two places)
- Inconsistent state management (React `useState` for splits, Zustand for terminal selection, TanStack Query for terminal list)
- Impossible flat-mode UI without bridging two systems
- `App.tsx` bloated with ~15 handler functions wiring split state

## Proposed Solution

Obsidian-inspired architecture with two core runtime abstractions and a Zustand store as their serialized projection:

1. **Workbench** — global singleton. Manages Splits, registers View types, provides cross-split queries. Analogous to Obsidian's `Workspace`.
2. **Split** — a pane container holding multiple Views (rendered as tabs in the UI). Manages view lifecycle within its scope. Analogous to Obsidian's `WorkspaceTabs` inside `rootSplit`.
3. **View** — per-view lifecycle instance, manages backend resources. Metadata on the class (`getViewType()`, `getDisplayText()`, `getIcon()`, `component`). Analogous to Obsidian's `View`.
4. **React component** — pure rendering, receives props from store. Tab bar is a rendering detail of Split, not a first-class API concept.

API flow (mirrors Obsidian's `getLeaf` + `setViewState`):
```typescript
const split = workbench.getSplit('primary')
await split.setViewState({ type: 'terminal', state: { worktreeId } })
```

Supporting pieces:
- **Store (WorkbenchState)** — serialized projection of Workbench/Split state in Zustand. React reads from here. Workbench writes to here.
  ```typescript
  interface WorkbenchState {
    splits: Record<string, SplitData>   // splitId → { viewIds, activeViewId }
    views: Record<string, ViewData>     // viewId → { type, title?, state? }
    splitOrder: string[]
    activeSplitId: string
  }
  ```
- **View registration** — `workbench.registerView(type, () => new View())`. Pure factory, no instance tracking.

## Design Decisions (from brainstorm + review)

These decisions are settled and should not be revisited during implementation:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Workbench → Split → View (Obsidian-inspired) | Clean hierarchy, plugin-friendly, proven model |
| Store role | Serialized projection of runtime state (`WorkbenchState`) | React reads store; Workbench writes store. Store is never the source of truth for View instances. |
| View pattern | Per-view factory instance with Obsidian lifecycle | `onOpen()` / `onClose()` / `getState()` / `setState()` |
| View ↔ Split boundary | View does NOT know its id or which Split it belongs to | Split manages the association externally |
| `type` ownership | `type` stored in `ViewData` (store) + `view.getViewType()` (instance) | Store needs `type` for React to look up component; View instance is the source of truth |
| View metadata | On the View class (`getViewType()`, `getDisplayText()`, `getIcon()`, `component`) — Obsidian pattern | Class IS the descriptor |
| Instance tracking | Split holds its View instances, NOT a global registry, NOT store | Each Split manages its own views |
| Tab as concept | **Not a first-class API concept** — tab bar is a rendering detail of Split | Simplifies API; Split.views is the model, tab bar is the UI |
| API pattern | `split.setViewState({type, state})` — mirrors Obsidian's `leaf.setViewState` | Familiar, two-step: get container → set content |
| `hookable` dependency | **Dropped** — use plain method overrides | Only 2 View impls; plain `onOpen()`/`onClose()` suffice |
| Mode | Start with Mode A (Grouped), flat view IDs enable Mode B later | Grouped matches current UX; flat is a rendering derivation |

## Design Decisions Needed (resolved here)

These were open questions in the brainstorm. Resolved for implementation:

### 1. View Deduplication

**Decision:** Focus existing view. Do not create a View instance if a matching one already exists.

```typescript
// In Split.setViewState
async setViewState(viewState: ViewState): Promise<View> {
  // Check for existing view with same type + dedup key
  const existing = this.findView(viewState)
  if (existing) {
    this.setActiveView(existing)
    return existing
  }
  // Create new view...
}
```

Dedup strategy is per-type: Diff deduplicates by `type + state.file`, Terminal never deduplicates (each call creates a new PTY).

> **Research Insight — TOCTOU race:** Two rapid `setViewState` calls for the same diff can both pass the dedup check. Use an atomic check-and-reserve in the store write to prevent duplicates.

### 2. Error Handling in View Lifecycle

**Decision:** Wrap in try/catch. Call `view.onClose()` defensively on failure. Throw to caller.

```typescript
// In Split.setViewState
async setViewState(viewState: ViewState): Promise<View> {
  const view = workbench.createView(viewState.type)
  try {
    await view.setState(viewState.state ?? {})
    await view.onOpen()
    // ... write to store
    return view
  } catch (error) {
    try { await view.onClose(); } catch {}
    throw error
  }
}
```

> **Research Insight:** If `view.onOpen()` partially succeeds (PTY created but response parse fails), the View holds a `terminalId` but is never tracked. Calling `view.onClose()` in the catch block ensures the PTY is killed.

### 3. Secondary Split Auto-Creation

**Decision:** When opening a diff and no secondary split exists, auto-create it.

```typescript
// Caller (App.tsx)
async function handleSelectDiffFile(file: DiffFileInfo) {
  let split = workbench.getSplit('secondary')
  if (!split) split = workbench.createSplit('secondary')
  await split.setViewState({ type: 'diff', state: { file, repoPath } })
}
```

### 4. DiffView Needs `repoPath`

**Decision:** Store `repoPath` in `ViewData.state` alongside `DiffFileInfo`.

```typescript
interface DiffViewState {
  file: DiffFileInfo
  repoPath: string
}
```

### 5. Worktree Switch

**Decision:** Caller composes `workbench.closeAll()` + `split.setViewState()`. No composite method on Workbench. No `useEffect`.

```typescript
// App.tsx handleSelectTask
async function handleSelectTask(task: Task) {
  await workbench.closeAll()
  const split = workbench.getSplit('primary')
  await split.setViewState({ type: 'terminal', state: { worktreeId, worktreePath } })
}
```

> **Research Insight — Double-fire race:** Rapid task clicks can invoke this twice before the first `closeAll` completes. Guard with an operation state flag at the call site or in Workbench.

### 6. Toggle Secondary Split Removal

**Decision:** Closing a split closes all its Views first.

```typescript
// workbench.closeSplit internally:
async closeSplit(id: string) {
  const split = this.getSplit(id)
  if (!split) return
  await split.closeAll()   // close all views in the split
  // ... remove split from store
}
```

### 7. "New View" Menu Filtering

**Decision:** View base class has `creatable` property (defaults to `true`). DiffView sets `creatable = false`. Tab bar "+" menu queries `workbench.creatableTypes()`.

### 8. PTY Exit Behavior

**Decision:** View stays open. User closes manually. The React component already handles the "exit" event by writing "[Process exited]" to the xterm buffer.

### 9. Archive Task Integration

**Decision:** `archiveTaskMutation.onSuccess` calls `workbench.closeAll()` if the archived task's worktree is currently selected.

### 10. oRPC in React Components

**Decision:** React components MAY use oRPC for **data streaming** (terminal output, write, resize). They must NOT use oRPC for **view lifecycle** (create, close). The spec's "no oRPC" rule applies to lifecycle only.

### 11. closeAll Error Resilience

**Decision:** Use catch-and-continue, not fail-fast.

```typescript
// In Split.closeAll
async closeAll() {
  for (const view of this.views) {
    try { await view.onClose(); } catch (e) { console.error(e); }
  }
  this._views.clear()
  // ... update store
}
```

### 12. Last View in Secondary Split

**Decision:** Closing the last view in the secondary split does NOT auto-collapse. The user collapses manually. An empty split shows an empty state message.

## Technical Approach

### Implementation Phases

#### Phase 1: Foundation (types + View base + Workbench/Split)

New files, zero existing code changes. All existing behavior continues working.

**Tasks:**

1. **Create `workbench/types.ts`**
   - `ViewData` — `{ type: string, title?: string, state?: Record<string, unknown> }` (store data)
   - `SplitData` — `{ viewIds: string[], activeViewId: string | null }`
   - `WorkbenchState` — `{ splits, views, splitOrder, activeSplitId }`
   - `ViewState` — `{ type: string, state?: Record<string, unknown> }` (input to `setViewState`)
   - `DiffViewState` interface (`{ file: DiffFileInfo, repoPath: string }`)

2. **Create `workbench/view.ts`**
   - `View` abstract class — Obsidian-inspired
   - Metadata: `getViewType(): string`, `getDisplayText(): string`, `getIcon(): string`, `component: ComponentType`
   - Lifecycle: `onOpen(): Promise<void>`, `onClose(): Promise<void>`
   - State: `getState(): Record<string, unknown>`, `setState(state: unknown): Promise<void>`
   - `creatable: boolean` (defaults to `true`)

3. **Create `workbench/split.ts`**
   - `Split` class — manages views within a pane
   - `setViewState(viewState: ViewState): Promise<View>` — creates View, calls lifecycle, writes store
   - `get views(): View[]`, `get activeView(): View | null`
   - `setActiveView(view: View): void`
   - `closeView(view: View): Promise<void>`
   - `closeAll(): Promise<void>` — catch-and-continue error resilience
   - `findView(viewState: ViewState): View | null` — for dedup
   - Holds internal `Map<string, View>` (viewId → View instance)

4. **Create `workbench/workbench.ts`**
   - `Workbench` class — global singleton
   - View registration: `registerView(type, factory: () => View)`
   - Split management: `getSplit(id): Split | null`, `createSplit(id): Split`, `closeSplit(id): Promise<void>`, `get splits(): Split[]`
   - Cross-split queries: `getViewsOfType(type): { split: Split, view: View }[]`, `closeViewsOfType(type): Promise<void>`
   - Global operations: `closeAll(): Promise<void>`
   - Convenience: `creatableTypes(): string[]`
   - Internal: `createView(type): View` (calls registered factory)
   - Writes to store on every mutation

   > **Key principle:** Workbench + Split are the source of truth for View instances. Store is their serialized projection for React.

5. **Update `split-state.ts` to `WorkbenchState` model**
   - Replace `PaneLeaf[]` model with `WorkbenchState` shape
   - Update pure functions: `addView`, `removeView`, `setActiveView`, `addSplit`, `removeSplit`
   - These become the "store write" helpers that Workbench/Split call inside `appStore.setState()`

6. **Update `split-state.test.ts`**
   - Migrate all existing tests to new model
   - Add tests for: dedup lookup, split creation/removal, view ordering

**Verification:** `pnpm run test` — all tests pass. `pnpm run typecheck` — no errors.

#### Phase 2: View Implementations + Store Integration

Create View classes. Still no React component changes.

**Tasks:**

7. **Create `workbench/views/terminal-lifecycle.ts`** (see naming note)
   - `TerminalLifecycle extends View`
   - `onOpen()` → creates PTY via oRPC
   - `onClose()` → closes PTY via oRPC
   - `getViewType() = "terminal"`, `creatable = true`
   - `getState()` / `setState()` — serialize/restore terminal state

   > **Research Insight — Name collision:** The existing React component `terminal-view.tsx` exports `TerminalView`. Name the lifecycle class `TerminalLifecycle` / file `terminal-lifecycle.ts` to avoid collision.

8. **Create `workbench/views/diff-view.ts`**
   - `DiffView extends View`
   - `onOpen()` → no-op (diff is purely client-side rendering)
   - `onClose()` → no-op
   - `getViewType() = "diff"`, `creatable = false`

9. **Create `stores/slices/workbench-slice.ts`**
   - `WorkbenchSlice` — thin Zustand slice holding `WorkbenchState`
   - React reads from here via `useAppStore(s => s.workbench)`
   - Workbench/Split write here via `appStore.setState()`

10. **Update `stores/app-store.ts`**
    - Add `WorkbenchSlice` to `AppStore`
    - Remove `TerminalSlice`

11. **Update `stores/slices/workspace-slice.ts`**
    - Remove `worktreeTerminalIds`, `addWorktreeTerminal`, `removeWorktreeTerminal`

**Verification:** `pnpm run typecheck` passes. Unit tests for Workbench/Split (mock oRPC + real store).

#### Phase 3: React Component Migration

Wire the new system into the UI.

**Tasks:**

12. **Create `components/terminal-renderer.tsx`**
    - Reads `viewData.state` from store, renders existing `TerminalView` component
    - Passes `isVisible` prop through

13. **Create `components/diff-renderer.tsx`**
    - Reads `DiffViewState` from store, renders `SingleFileDiff`

14. **Rename `pane-tabs.tsx` → `tab-bar.tsx`**
    - Read view data from store via `useAppStore`
    - **Extract `TabBarItem` as a separate component** for hooks correctness
    - Look up View metadata via `workbench.getViewsOfType()` or store's `viewData.type` + registered metadata
    - Call `split.closeView()` / `split.setViewState()` for user actions
    - "+" menu: `workbench.creatableTypes()`

    > **Research Insight — Rules of Hooks violation:** Extract `TabBarItem` to avoid calling hooks inside `.map()`.

15. **Rename `pane-leaf.tsx` → `content-renderer.tsx`**
    - Generic renderer: looks up component by `viewData.type` from registered views
    - Receives `splitId` + `viewId` props

16. **Update `split-pane.tsx`**
    - Read from store via `useAppStore`
    - Remove all callback props (actions go through Workbench/Split)
    - Render `TabBar` + `ContentRenderer`

17. **Update `split-root.tsx`**
    - Remove all callback props
    - Read `splitOrder`, `activeSplitId` from store

18. **Update `App.tsx`**
    - Remove `splitState` useState and all `handle*` handler functions
    - `handleSelectTask`: `await workbench.closeAll()` then `split.setViewState({type: 'terminal', ...})`
    - `handleSelectDiffFile`: `split.setViewState({type: 'diff', ...})`
    - `archiveTaskMutation.onSuccess`: `await workbench.closeAll()`

19. **Delete `terminal-panel.tsx`**
    - Replaced by TerminalLifecycle + TerminalRenderer

20. **Delete `stores/slices/terminal-slice.ts`**
    - Replaced by WorkbenchSlice + Workbench/Split

**Verification:** `pnpm run dev` — app works end-to-end. Manual testing of all flows.

#### Phase 4: Test Coverage + Cleanup

21. **Write integration tests for Workbench/Split**
    - `split.setViewState()` → view created, store updated
    - Dedup: same diff → focuses existing, doesn't create duplicate
    - `split.closeView()` → `view.onClose()` called, removed from store
    - `workbench.closeAll()` → all views closed
    - `workbench.closeSplit()` → all views in split closed, split removed
    - Error in `onOpen()` → `onClose()` called, no orphan

22. **Update existing tests**
    - `split-state.test.ts` — already updated in Phase 1
    - Remove any tests that reference `TerminalSlice`

23. **Clean up imports and dead code**
    - Remove `terminal-panel.tsx`, `terminal-slice.ts`
    - Remove unused exports

## Acceptance Criteria

### Functional Requirements

- [ ] Multiple terminal views can be opened per split (each with its own PTY)
- [ ] Diff views deduplicate — `split.setViewState` for same file focuses existing
- [ ] Opening a diff auto-creates secondary split if none exists
- [ ] `split.closeView()` calls `view.onClose()` for backend cleanup (PTY kill for terminals)
- [ ] Worktree switch: `workbench.closeAll()` + `split.setViewState({type: 'terminal', ...})`
- [ ] `workbench.closeSplit()` closes all Views in that split
- [ ] "+" menu shows only `workbench.creatableTypes()` (Terminal, not Diff)
- [ ] Archive task calls `workbench.closeAll()` for the archived worktree
- [ ] Error during `view.onOpen()` calls `view.onClose()` defensively, does not leak View instances

### Race Condition Coverage (from deepening)

- [ ] Concurrent `setViewState` for same diff does not create duplicate views
- [ ] Rapid worktree switch does not interleave `closeAll`/`setViewState` calls
- [ ] `closeSplit` during an in-progress `setViewState` does not orphan the View
- [ ] Double-click on "+" button does not create two terminals

### Non-Functional Requirements

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run test` passes
- [ ] No `useEffect` for state synchronization (Workbench/Split drive store)
- [ ] `App.tsx` reduced by ~150+ lines of handler code
- [ ] `TerminalSlice` and `terminal-panel.tsx` deleted

## Affected Files

| File | Change |
|------|--------|
| **New: `workbench/types.ts`** | ViewData, SplitData, WorkbenchState, ViewState, DiffViewState |
| **New: `workbench/view.ts`** | View abstract class (Obsidian-inspired lifecycle) |
| **New: `workbench/split.ts`** | Split class — view management within a pane |
| **New: `workbench/workbench.ts`** | Workbench class — global singleton, split management, view registration |
| **New: `workbench/views/terminal-lifecycle.ts`** | TerminalLifecycle class |
| **New: `workbench/views/diff-view.ts`** | DiffView class |
| **New: `components/terminal-renderer.tsx`** | Thin wrapper for terminal content |
| **New: `components/diff-renderer.tsx`** | Thin wrapper for diff content |
| **New: `stores/slices/workbench-slice.ts`** | WorkbenchSlice — Zustand slice holding WorkbenchState |
| `components/layout/split-state.ts` | Rewrite to WorkbenchState pure functions |
| `components/layout/split-state.test.ts` | Tests for new model |
| `components/layout/pane-tabs.tsx` → `tab-bar.tsx` | Store-connected, Workbench metadata |
| `components/layout/pane-leaf.tsx` → `content-renderer.tsx` | Generic via view type lookup |
| `components/layout/split-pane.tsx` | Store-connected, simplified |
| `components/layout/split-root.tsx` | Store-connected, layout-only |
| `App.tsx` | Remove ~150 lines, use Workbench/Split API |
| `stores/app-store.ts` | Add WorkbenchSlice, remove TerminalSlice |
| `stores/slices/index.ts` | Update re-exports |
| `stores/slices/workspace-slice.ts` | Remove worktreeTerminalIds |
| **Delete: `components/terminal/terminal-panel.tsx`** | Replaced by TerminalLifecycle + TerminalRenderer |
| **Delete: `stores/slices/terminal-slice.ts`** | Replaced by WorkbenchSlice |
| `apps/desktop/package.json` | No new dependencies |

## References

- Brainstorm: `docs/brainstorms/2026-02-09-flat-tab-data-model-brainstorm.md`
- Current split state: `apps/desktop/src/renderer/src/components/layout/split-state.ts`
- Current terminal panel: `apps/desktop/src/renderer/src/components/terminal/terminal-panel.tsx`
- Current terminal slice: `apps/desktop/src/renderer/src/stores/slices/terminal-slice.ts`
- Current App.tsx wiring: `apps/desktop/src/renderer/src/App.tsx:215-378`
- Backend terminal manager: `apps/desktop/src/main/terminal/terminal-manager.ts`
- Backend terminal router: `apps/desktop/src/main/ipc/router/terminal.ts`
