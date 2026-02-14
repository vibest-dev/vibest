---
title: "refactor: Workbench / Part / View Architecture"
type: refactor
date: 2026-02-10
brainstorm: docs/brainstorms/2026-02-09-flat-tab-data-model-brainstorm.md
revised: 2026-02-12
---

# refactor: Workbench / Part / View Architecture

## Overview

Unify the desktop app's two-layer tab management (split-level categories in `split-state.ts` + module-level internal tabs in `TerminalPanel`) into an Obsidian-inspired Workbench / Split / Part / View architecture.

- **Workbench** — global singleton. Manages Splits, registers View types, provides global operations.
- **Split** — pane container holding multiple Parts (rendered as tabs).
- **Part** — a positional slot within a Split. Holds one View at a time. Can swap Views via `setViewState`.
- **View** — per-part lifecycle instance managing backend resources. Holds `this.part` reference.

This eliminates duplicated tab logic, enables multiple views of the same kind per split, and removes ~150 lines of handler code from `App.tsx`.

## Problem Statement

The current system has two separate tab management layers:

1. **Split-level tabs** (`PaneLeaf[]` in `split-state.ts`) — Terminal and Diff as fixed categories, one per kind per split, with IDs like `"${splitId}:${kind}"`
2. **Module-level tabs** (`TerminalPanel` + TanStack Query + `TerminalSlice`) — individual terminal instances managed internally with their own tab bar, create/close logic, and active selection

This creates:
- Duplicated tab logic (close, activate, create in two places)
- Inconsistent state management (React `useState` for splits, Zustand for terminal selection, TanStack Query for terminal list)
- Impossible flat-mode UI without bridging two systems
- `App.tsx` bloated with ~15 handler functions wiring split state

## Design Decisions

These decisions are settled and should not be revisited during implementation:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Workbench → Split → Part → View | Obsidian-inspired, proven model, Part enables View swapping |
| Part layer | Part is a positional slot; View is the content | Same Part can swap Views (like Obsidian's Leaf) without losing tab position |
| View ↔ Part | View holds `this.part`; Part holds `this.parent` (Split or Sidebar) | View can sense its container via `this.part.parent instanceof Split` |
| Registration | `workbench.registerView(type, (part) => new View(part))` | One registration, can open anywhere |
| Store role | Minimal projection for React rendering | Workbench/Split/Part are runtime truth; store is a serialized view |
| Store structure | Arrays for splits, arrays for parts, id-based references | Flat, simple, serializable |
| View state in store | `part.state: unknown` holds renderable data per view type | Enables persistence; each renderer casts to its own type |
| View instance state | Non-renderable runtime data stays on View instance | e.g., PTY connection handle |
| Workbench instantiation | Module-level singleton export | Needs `appStore` and `orpc` at creation time |
| Store access | Split → Workbench → appStore (no direct import in Split) | Clean dependency chain |
| `hookable` | Dropped — plain method overrides | Only 2 View impls |

## Store (Minimal)

```typescript
interface WorkbenchState {
  splits: Array<{
    id: string
    partIds: string[]
    activePartId: string | null
  }>
  parts: Array<{
    id: string
    viewType: string
    title: string
    state: unknown
  }>
}
```

React reads from this store only. Workbench writes to it on every mutation.

- **`splits`** — ordered list of splits. No split = no UI. One split = single pane. Two splits = split view.
- **`parts`** — flat list of all parts. Referenced by `partIds` in splits.
- **`state`** — view-type-specific renderable data (`{ terminalId }` for terminal, `{ file, repoPath }` for diff). Each renderer casts to its own type.

No `splitOrder`, no `activeSplitId`, no `icon` — not needed yet.

## Runtime Classes

### View (abstract)

```typescript
abstract class View {
  part: Part  // injected by factory

  abstract getViewType(): string
  abstract getDisplayText(): string
  abstract getIcon(): string
  abstract component: React.ComponentType<ViewProps>

  creatable: boolean = true  // show in "+" menu

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  getState(): unknown { return {} }
  async setState(state: unknown): Promise<void> {}
}
```

### Part

```typescript
class Part {
  id: string
  view: View
  parent: Split  // container reference

  async setViewState(viewState: { type: string, state?: unknown }): Promise<void>
  detach(): void  // close this part
}
```

`setViewState` swaps the View: old View `onClose()` → new View created → `setState()` → `onOpen()` → store updated.

### Split

```typescript
class Split {
  id: string
  parts: Map<string, Part>
  activePart: Part | null

  async setViewState(viewState): Promise<View>  // create Part + View
  setActivePart(part: Part): void
  async closePart(part: Part): Promise<void>
  async closeAll(): Promise<void>  // catch-and-continue
  findView(viewState): Part | null  // for dedup
}
```

### Workbench

```typescript
class Workbench {
  registerView(type: string, factory: (part: Part) => View): void
  getSplit(id: string): Split | null
  createSplit(id: string): Split
  async closeSplit(id: string): Promise<void>
  async closeAll(): Promise<void>
  creatableTypes(): string[]
}
```

Module-level export:
```typescript
export const workbench = new Workbench(appStore, orpc)
```

## View Implementations

### TerminalView

```typescript
class TerminalView extends View {
  private terminalId!: string  // runtime state, not in store

  getViewType() { return 'terminal' }
  creatable = true

  async setState(state: unknown) {
    // extract worktreeId from state
  }

  async onOpen() {
    // orpc.terminal.create → this.terminalId
    // update part store: { terminalId: this.terminalId }
  }

  async onClose() {
    // orpc.terminal.close(this.terminalId)
  }
}
```

Existing React component `TerminalView` in `terminal-view.tsx` renamed to `TerminalRenderer` to free up the name.

### DiffView

```typescript
class DiffView extends View {
  getViewType() { return 'diff' }
  creatable = false  // opened from sidebar, not "+" menu

  async setState(state: unknown) {
    // store file + repoPath in part store
  }

  async onOpen() { /* no-op */ }
  async onClose() { /* no-op */ }
}
```

## Key Flows

### Open Terminal

```
User clicks "+" → Terminal
  → split.setViewState({ type: 'terminal', state: { worktreeId } })
    → 1. workbench.createView('terminal', part)
    → 2. view.setState({ worktreeId })
    → 3. view.onOpen() → orpc.terminal.create → get terminalId
    → 4. Part created, bound to View
    → 5. Store updated (new part in splits, new part in parts)
    → 6. React renders TerminalRenderer
```

### Swap View in Part

```
part.setViewState({ type: 'settings' })
  → 1. old view.onClose()
  → 2. workbench.createView('settings', part)
  → 3. new view.setState(state)
  → 4. new view.onOpen()
  → 5. part.view = new view
  → 6. Store updated (part.viewType changed)
  → 7. React re-renders with new component
```

### Close Tab

```
User clicks "×"
  → split.closePart(part)
    → 1. view.onClose() → orpc.terminal.close
    → 2. Part removed from Split
    → 3. Store updated
    → 4. React unmounts component
```

### Worktree Switch

```
User selects task
  → workbench.closeAll()
    → close all views (catch-and-continue)
    → clear store
  → split.setViewState({ type: 'terminal', state: { worktreeId } })
```

## Error Handling

If `view.onOpen()` fails, call `view.onClose()` defensively to clean up partial resources (e.g., PTY created but response parse failed):

```typescript
// In Split.setViewState
try {
  await view.setState(state)
  await view.onOpen()
} catch (error) {
  try { await view.onClose() } catch {}
  throw error
}
```

## Deduplication

Per-type strategy:
- **Terminal**: never dedup (each call creates new PTY)
- **Diff**: dedup by `type + state.file` — focus existing Part if found

## Implementation Phases

### Phase 1: Types + Runtime Classes

New files only. Zero changes to existing code. App continues working.

1. **Create `workbench/types.ts`** — `WorkbenchState`, `ViewProps`, `ViewState`
2. **Create `workbench/view.ts`** — `View` abstract class
3. **Create `workbench/part.ts`** — `Part` class
4. **Create `workbench/split.ts`** — `Split` class
5. **Create `workbench/workbench.ts`** — `Workbench` class, module-level singleton export

**Verification:** `pnpm run typecheck` passes.

### Phase 2: Store + View Implementations

6. **Create `stores/slices/workbench-slice.ts`** — `WorkbenchSlice` holding `WorkbenchState`
7. **Create `workbench/views/terminal-view.ts`** — `TerminalView extends View`
8. **Create `workbench/views/diff-view.ts`** — `DiffView extends View`
9. **Update `stores/app-store.ts`** — add `WorkbenchSlice`
10. **Wire Workbench to write store** — Workbench/Split mutations update `WorkbenchState` via `appStore.setState()`

**Verification:** `pnpm run typecheck` passes. Unit tests for Workbench/Split (mock orpc).

### Phase 3: React Migration

Wire new system into UI. Old components replaced.

11. **Rename `terminal-view.tsx` → `terminal-renderer.tsx`** — rename React component `TerminalView` to `TerminalRenderer`, update all imports
12. **Create `components/diff-renderer.tsx`** — reads part state, renders `SingleFileDiff`
13. **Update `pane-tabs.tsx` → `tab-bar.tsx`** — read from workbench store, extract `TabBarItem` component (hooks correctness)
14. **Update `pane-leaf.tsx` → `content-renderer.tsx`** — generic renderer by viewType lookup
15. **Update `split-pane.tsx`** — read from store, remove callback props
16. **Update `split-root.tsx`** — read from store
17. **Update `App.tsx`** — remove split/tab handlers, use Workbench/Split API
18. **Delete `terminal-panel.tsx`**
19. **Delete `stores/slices/terminal-slice.ts`**
20. **Update `stores/slices/workspace-slice.ts`** — remove `worktreeTerminalIds`

**Verification:** `pnpm run dev` — app works end-to-end.

### Phase 4: Tests + Cleanup

21. **Rewrite `split-state.test.ts`** — tests for new `WorkbenchState` pure functions
22. **Write integration tests** — Workbench/Split lifecycle, dedup, error handling, closeAll
23. **Clean up dead code** — remove unused exports, old split-state functions

**Verification:** `pnpm run test` passes. `pnpm run typecheck` passes.

## Affected Files

| File | Change |
|------|--------|
| **New: `workbench/types.ts`** | WorkbenchState, ViewProps, ViewState |
| **New: `workbench/view.ts`** | View abstract class |
| **New: `workbench/part.ts`** | Part class |
| **New: `workbench/split.ts`** | Split class |
| **New: `workbench/workbench.ts`** | Workbench singleton |
| **New: `workbench/views/terminal-view.ts`** | TerminalView (lifecycle class) |
| **New: `workbench/views/diff-view.ts`** | DiffView |
| `components/terminal/terminal-view.tsx` → `terminal-renderer.tsx` | Rename TerminalView → TerminalRenderer |
| **New: `components/diff-renderer.tsx`** | Diff content wrapper |
| **New: `stores/slices/workbench-slice.ts`** | WorkbenchSlice |
| `components/layout/split-state.ts` | Rewrite to WorkbenchState pure functions |
| `components/layout/split-state.test.ts` | Rewrite tests |
| `components/layout/pane-tabs.tsx` → `tab-bar.tsx` | Store-connected |
| `components/layout/pane-leaf.tsx` → `content-renderer.tsx` | Generic viewType renderer |
| `components/layout/split-pane.tsx` | Store-connected |
| `components/layout/split-root.tsx` | Store-connected |
| `App.tsx` | Remove ~150 lines of handler code |
| `stores/app-store.ts` | Add WorkbenchSlice, remove TerminalSlice |
| `stores/slices/index.ts` | Update exports |
| `stores/slices/workspace-slice.ts` | Remove worktreeTerminalIds |
| **Delete: `components/terminal/terminal-panel.tsx`** | Replaced by TerminalView + TerminalRenderer |
| **Delete: `stores/slices/terminal-slice.ts`** | Replaced by WorkbenchSlice |

## Acceptance Criteria

- [ ] Multiple terminal views per split (each with own PTY)
- [ ] Diff dedup — same file focuses existing Part
- [ ] Opening diff auto-creates secondary split if needed
- [ ] `view.onClose()` called on tab close (PTY cleanup)
- [ ] Worktree switch: `closeAll()` + new terminal
- [ ] "+" menu shows only `creatableTypes()` (Terminal, not Diff)
- [ ] Error in `onOpen()` calls `onClose()` defensively
- [ ] `Part.setViewState()` can swap View in place
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run test` passes
- [ ] `App.tsx` reduced by ~150 lines
- [ ] `TerminalSlice` and `terminal-panel.tsx` deleted
