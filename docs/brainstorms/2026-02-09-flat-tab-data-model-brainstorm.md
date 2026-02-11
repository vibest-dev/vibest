# Flat Tab Data Model for Split Panes

**Date:** 2026-02-09
**Status:** Brainstorm in progress
**Scope:** Desktop app layout — split pane tab system

## What We're Building

A unified, extensible flat tab data model with a three-layer architecture:

1. **Tab** — pure data in Zustand store (tab identity, kind, state). Normalized by ID.
2. **View** — per-tab lifecycle instance (create resources, destroy resources, declare React component). Managed by ViewRegistry. Does NOT hold Tab data — framework handles the association.
3. **React component** — pure rendering (receives tab data + isVisible as props)

It supports two visual organization modes:

- **Mode A (Grouped):** Two stacked tab bars — a top bar showing kind-groups (Terminal, Diff, ...) and a bottom bar showing individual tabs within the active group.
- **Mode B (Flat):** A single tab bar where all tabs appear as siblings.

Both modes are driven by the **same flat tab ID list** per split. The mode is initially a code constant, later exposed as a user setting.

## Naming Conventions

| Concept | Name | What it is | Where it lives |
|---------|------|------------|----------------|
| Content entity (data) | **Tab** (`TabData`) | `{ id, kind, title, state }` — plain object | Zustand store (normalized) |
| Content handler (lifecycle) | **View** (`View`) | Per-tab class instance — `open()`, `close()`, `component` | ViewRegistry |
| UI navigation element | **Tab** (React `<Tab>`) | Clickable element in the tab bar | React component |
| Container | **Split** | Holds a list of tab IDs + active tab | Zustand store |
| Layout | **SplitLayout** | Renders splits, not a domain concept | React component |
| Factory + instance manager | **ViewRegistry** | `kind → factory`, `tabId → View instance` | Module singleton |

**Why these names:**
- **Tab** is the most natural user-facing term — "open a tab", "close a tab"
- **View** is the developer-facing registration concept — "register a view" to display content. You register a View type, not a Tab type. Follows Obsidian's naming.
- **Split** is the container — no ambiguity with other concepts

## Why This Approach

The current system has two separate tab management layers:
1. Split-level tabs (`PaneLeaf[]` in `split-state.ts`) — Terminal, Diff as categories
2. Module-level tabs (e.g., TerminalPanel's internal tab list via TanStack Query + Zustand TerminalSlice) — individual terminal instances

This creates duplicated tab logic, inconsistent state management, and makes a flat-mode UI impossible without bridging two systems.

**Unifying into a single flat model:**
- Eliminates the nested tab hierarchy
- Makes both modes trivial to implement as view-layer derivation
- Simplifies state transitions (one set of functions for all tab operations)
- Removes TerminalPanel's internal tab management responsibility

## Architecture

### Inspiration: VS Code and Obsidian

Both VS Code and Obsidian separate **data** (tab identity) from **lifecycle** (business logic) from **rendering** (UI):

| Layer | VS Code | Obsidian | Our Design |
|-------|---------|----------|------------|
| Data | `EditorInput` (class) | `ViewState` (plain object) | `TabData` (plain object, normalized in store) |
| Lifecycle | `EditorPane` (per-group instance) | `View` (per-leaf instance) | `View` (per-tab instance, factory pattern) |
| Registry | `EditorPaneRegistry` (descriptor+pattern) | `registerView(type, factory)` | `ViewRegistry` (kind→factory + tabId→instance) |
| Rendering | `EditorPane.createEditor()` (imperative DOM) | `View.containerEl` (imperative DOM) | React component (declarative) |
| State mgmt | Services + DI | Internal | Zustand `SplitSlice` (vanilla store, usable from JS) |
| Extension model | Dual-track (core registry + Extension API) | Single-track (`registerView`) | Single-track (`viewRegistry.register`) |

Key difference from VS Code/Obsidian: they are imperative (View class IS the renderer). We use React (declarative), so rendering is separated from the lifecycle class. This creates two lifecycle layers that must stay in their lanes.

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Tab (Data)                                         │
│                                                             │
│   Pure data. No logic. Normalized in Zustand store.         │
│   tabs: Record<string, TabData>                             │
│   { id, kind, title, state }                                │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: View (Lifecycle)                                   │
│                                                             │
│   Per-tab instance (factory pattern). Extends Hookable.     │
│   Manages business lifecycle: create/close backend          │
│   resources, respond to activation/deactivation.            │
│   Does NOT render. Does NOT hold Tab data.                  │
│   Holds own runtime state. Called by framework, NOT React.  │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: React Component (Rendering)                        │
│                                                             │
│   Pure rendering. Receives { tab, isVisible } as props.     │
│   Manages DOM lifecycle (xterm attach/detach, layout).      │
│   Does NOT manage backend resources.                        │
│   Responds to props, NOT to events.                         │
├─────────────────────────────────────────────────────────────┤
│ Orchestration: Zustand SplitSlice (Framework)               │
│                                                             │
│   Coordinates View lifecycle + Tab store atomically.        │
│   View never sees Tab. Framework handles the association.   │
│   openTerminal: view.open() → createTab → bind → addTab    │
│   closeTab: view.close() → destroy → removeTab             │
│   activateTab: view.onDeactivated/onActivated → set state   │
└─────────────────────────────────────────────────────────────┘
```

### View ↔ Tab Boundary

**View does NOT hold Tab data.** Tab management is entirely internal to the framework. View is a pure "content provider" that only knows:

| View knows | View does NOT know |
|---|---|
| Its own kind, icon, kindLabel | tabId |
| How to create/destroy resources | Tab data structure |
| What React component to use | How store works |
| Where to open (target split) | Registry binding |
| Its own runtime state | Tab bar rendering |

The association between View and Tab is managed internally by the framework (ViewRegistry + SplitSlice).

### Communication Between Layers

| From → To | Mechanism | Timing Issue? |
|-----------|-----------|---------------|
| Framework → View | Direct method call (`view.open()`, `view.close()`) | No — synchronous/await |
| Framework → React | Zustand state update → props change | No — React's natural flow |
| React → Framework | Zustand actions (`closeTab()`, `activateTab()`) | No — user-triggered |
| View → React | **Never.** View does not talk to React components. | N/A |
| React → View | **Never.** React components do not call View methods. | N/A |
| View → Tab | **Never.** View does not read or write Tab data. | N/A |

This avoids the event timing problem: React components respond to **props** (state-driven, never missed), not to **events** (fire-and-forget, can be missed if listener isn't mounted yet).

### Factory Pattern (Per-Tab Instance)

Each tab gets its own View instance, following Obsidian's approach.

| | Singleton (rejected) | Factory (chosen) |
|---|---|---|
| Instance count | 1 per kind | 1 per tab |
| Per-tab state | In store only | Instance fields (runtime) + store (serializable) |
| Method calls | `view.close(tab)` — pass tab every time | `view.close()` — instance has its own state |
| Isolation | None — all tabs share one object | Full — each tab is independent |

## Data Model

### Type System

Builtin kinds export their types for compile-time safety. New kinds added via the same registration mechanism manage their own types.

```typescript
// === Builtin types — exported for everyone to use ===
type BuiltinTabKind = "terminal" | "diff";

// Open for plugins: any string works, but builtin literals get autocomplete
type TabKind = BuiltinTabKind | (string & {});

// Type-safe state mapping for builtin kinds
interface BuiltinTabStateMap {
  terminal: { terminalId: string };
  diff: DiffFileInfo;
}
```

### TabData (Normalized in Store)

```typescript
interface TabData {
  id: string;        // Unique tab ID, generated by framework
  kind: TabKind;     // Used for grouping, renderer dispatch, registry lookup
  title: string;     // Display name: "Terminal 1", "README.md"
  state?: unknown;   // Kind-specific data — typed via helpers for builtins
  pinned?: boolean;  // Reserved for future use
}
```

### Type-Safe Accessors (Read + Write)

```typescript
// Read: type-safe state access for builtin kinds
function getBuiltinTabState<K extends BuiltinTabKind>(
  tab: TabData, kind: K
): BuiltinTabStateMap[K] {
  return tab.state as BuiltinTabStateMap[K];
}

// Write: type-safe tab creation — overloaded for builtin vs plugin
function createTab<K extends BuiltinTabKind>(
  kind: K,
  state: BuiltinTabStateMap[K],
  meta: { id: string; title: string; pinned?: boolean }
): TabData;
function createTab(
  kind: string,
  state: unknown,
  meta: { id: string; title: string; pinned?: boolean }
): TabData;
function createTab(kind: string, state: unknown, meta: any): TabData {
  return { kind, state, ...meta };
}

// Builtin — compile-time validation
createTab("terminal", { terminalId: "t1" }, { id: "terminal-t1", title: "Terminal 1" }); // ✓
createTab("terminal", { wrong: true },      { id: "terminal-t1", title: "Terminal 1" }); // ✗ compile error
```

### SplitState (Normalized)

```typescript
interface SplitState {
  splitOrder: string[];
  primarySplitId: string;
  activeSplitId: string;

  // Normalized tab entities
  tabs: Record<string, TabData>;

  // Split → Tab relationships
  tabIdsBySplitId: Record<string, string[]>;
  activeTabIdBySplitId: Record<string, string | null>;
  lastActiveTabByKind: Record<string, Record<TabKind, string>>;  // For Mode A group switching
}
```

Tabs are normalized: `tabs` is a flat `Record<id, TabData>`, splits reference tabs by ID. This means:
- Updating a tab's title doesn't require finding which split it belongs to
- Moving a tab between splits only changes `tabIdsBySplitId`, not the tab itself

Pure functions in `split-state.ts` remain unchanged in spirit: `createSplitState`, `addTab`, `removeTab`, `setActiveTab`, `setActiveSplit`, `toggleSecondarySplit`. They operate on immutable `SplitState` and know nothing about View or backend resources.

### Tab ID Convention

Current: `"${splitId}:${kind}"` — one tab per kind per split.

New: `"${kind}-${key}"` or `"${kind}-${nanoid()}"` — multiple tabs of the same kind.

- Terminal: `"terminal-${terminalId}"` — key from backend
- Diff: `"diff-${staged ? "staged" : "unstaged"}-${filePath}"` — encodes staged status

Tab IDs are generated by the framework from View's `TabInit.key` or auto-generated with nanoid.

## View (Lifecycle Layer)

### TabInit — What View Returns

View's `open()` returns `TabInit` — the minimum data needed for the framework to create a Tab. View never sees the final TabData.

```typescript
interface TabInit {
  title: string;        // Display name
  state?: unknown;      // Kind-specific data for serialization/rendering
  key?: string;         // Optional dedup key → framework generates id: `${kind}-${key}`
  pinned?: boolean;
}
```

### Base Class

```typescript
import { Hookable } from "hookable";

type SplitTarget = "primary" | "secondary" | "active";

interface ViewHooks {
  created: () => void;
  beforeClose: () => void | Promise<void>;
  activated: () => void;
  deactivated: () => void;
}

interface ViewProps {
  tab: TabData;
  isVisible: boolean;
}

abstract class View extends Hookable<ViewHooks> {
  abstract kind: string;
  abstract icon: string;
  abstract kindLabel: string;
  abstract component: React.ComponentType<ViewProps>;

  // The only thing View decides about placement
  target: SplitTarget = "primary";

  constructor() { super(); }

  // Prepare resources, return data for Tab creation.
  // Framework handles TabData creation, ID generation, registry binding, store write.
  abstract open(...args: any[]): Promise<TabInit>;

  // Clean up backend resources. Uses own runtime state, not Tab.
  abstract close(): Promise<void>;

  // Tab became active. Non-rendering side effects only.
  onActivated(): void {}

  // Tab became inactive. Non-rendering side effects only.
  onDeactivated(): void {}

  // Restore from persisted state (future).
  restore?(data: unknown): Promise<void>;

  // Serialization (future).
  serialize?(): unknown;
}
```

### Terminal Implementation

```typescript
class TerminalView extends View {
  kind = "terminal" as const;
  icon = "terminal";
  kindLabel = "Terminal";
  component = TerminalRenderer;
  target = "primary" as const;

  private terminalId!: string;  // View's own runtime state

  constructor(private orpc: typeof orpc) { super(); }

  async open(worktreeId: string): Promise<TabInit> {
    const term = await this.orpc.terminal.create(worktreeId);
    this.terminalId = term.id;  // store in own state, not in Tab
    return {
      title: `Terminal ${n}`,
      state: { terminalId: term.id },
      key: term.id,
    };
  }

  async close(): Promise<void> {
    await this.callHook("beforeClose");
    await this.orpc.terminal.close(this.terminalId);  // uses own state
  }
}
```

### Diff Implementation

```typescript
class DiffView extends View {
  kind = "diff" as const;
  icon = "file-diff";
  kindLabel = "Diff";
  component = DiffRenderer;
  target = "secondary" as const;  // Diffs open in secondary split

  private file!: DiffFileInfo;

  async open(file: DiffFileInfo): Promise<TabInit> {
    this.file = file;
    return {
      title: file.staged ? `${file.path} (staged)` : file.path,
      state: file,
      key: `${file.staged ? "staged" : "unstaged"}-${file.path}`,
    };
  }

  async close(): Promise<void> {
    await this.callHook("beforeClose");
    // No backend cleanup needed for diffs
  }
}
```

## ViewRegistry

The registry manages **factories** (kind → how to create View instances) and **instances** (tabId → live View).

```typescript
// Type map for builtin kind → View subclass (enables overload inference)
interface BuiltinViewMap {
  terminal: TerminalView;
  diff: DiffView;
}

class ViewRegistry {
  private factories = new Map<string, () => View>();
  private instances = new Map<string, View>(); // tabId → View (internal!)

  register(kind: string, factory: () => View): void {
    if (this.factories.has(kind)) {
      throw new Error(`View "${kind}" already registered`);
    }
    this.factories.set(kind, factory);
  }

  unregister(kind: string): void {
    this.factories.delete(kind);
  }

  // Create instance — overloaded for builtin type inference
  createView<K extends keyof BuiltinViewMap>(kind: K): BuiltinViewMap[K];
  createView(kind: string): View;
  createView(kind: string): View {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`Unknown view kind: ${kind}`);
    return factory();
  }

  // --- Internal: framework use only, not exposed to plugins ---

  bind(tabId: string, view: View): void {
    this.instances.set(tabId, view);
  }

  getInstance(tabId: string): View | undefined {
    return this.instances.get(tabId);
  }

  destroy(tabId: string): void {
    this.instances.delete(tabId);
  }

  // List all registered kinds (for "new tab" menu)
  kinds(): string[] {
    return [...this.factories.keys()];
  }
}

export const viewRegistry = new ViewRegistry();
```

### Registration

```typescript
// App init
viewRegistry.register("terminal", () => new TerminalView(orpc));
viewRegistry.register("diff",     () => new DiffView());
```

## Zustand SplitSlice (Framework Orchestration)

The framework layer coordinates View lifecycle + Tab store atomically. View never sees Tab. All association is internal.

```typescript
import { viewRegistry } from "./view-registry";

interface SplitSlice {
  splitState: SplitState;

  // Generic actions
  closeTab: (splitId: string, tabId: string) => Promise<void>;
  activateTab: (splitId: string, tabId: string) => void;
  activateGroup: (splitId: string, kind: string) => void;
  resetTabs: () => Promise<void>;
  toggleSecondarySplit: () => void;

  // Builtin convenience (type-safe, wraps generic flow)
  openTerminal: (worktreeId: string) => Promise<void>;
  openDiff: (file: DiffFileInfo) => Promise<void>;
}

export const createSplitSlice: StateCreator<AppStore, [], [], SplitSlice> = (set, get) => ({
  splitState: createSplitState(),

  // --- Builtin convenience actions ---

  openTerminal: async (worktreeId) => {
    const view = viewRegistry.createView("terminal"); // → TerminalView (inferred)
    const init = await view.open(worktreeId);

    // Framework creates Tab — View doesn't know about this
    const tab: TabData = {
      id: init.key ? `${view.kind}-${init.key}` : `${view.kind}-${nanoid()}`,
      kind: view.kind,
      title: init.title,
      state: init.state,
      pinned: init.pinned,
    };

    // Framework manages association — View doesn't know about this
    viewRegistry.bind(tab.id, view);

    // Add to store using View's declared target
    set(s => ({
      splitState: addTab(s.splitState, tab, view.target),
    }));
  },

  openDiff: async (file) => {
    const view = viewRegistry.createView("diff"); // → DiffView (inferred)
    const init = await view.open(file);

    const tab: TabData = {
      id: init.key ? `${view.kind}-${init.key}` : `${view.kind}-${nanoid()}`,
      kind: view.kind,
      title: init.title,
      state: init.state,
    };

    viewRegistry.bind(tab.id, view);
    set(s => ({
      splitState: addTab(s.splitState, tab, view.target),
    }));
  },

  // --- Generic actions ---

  closeTab: async (splitId, tabId) => {
    const view = viewRegistry.getInstance(tabId);
    await view?.close();
    viewRegistry.destroy(tabId);
    set(s => ({
      splitState: removeTab(s.splitState, splitId, tabId),
    }));
  },

  activateTab: (splitId, tabId) => {
    const { splitState } = get();
    const prevId = splitState.activeTabIdBySplitId[splitId];
    if (prevId && prevId !== tabId) {
      viewRegistry.getInstance(prevId)?.onDeactivated();
    }
    viewRegistry.getInstance(tabId)?.onActivated();
    set(s => ({
      splitState: setActiveTab(s.splitState, splitId, tabId),
    }));
  },

  activateGroup: (splitId, kind) => {
    const { splitState } = get();
    const lastId = splitState.lastActiveTabByKind?.[splitId]?.[kind];
    const tabIds = splitState.tabIdsBySplitId[splitId]?.filter(id => splitState.tabs[id]?.kind === kind);
    const targetId = (lastId && tabIds?.includes(lastId)) ? lastId : tabIds?.[0];
    if (targetId) get().activateTab(splitId, targetId);
  },

  resetTabs: async () => {
    const { splitState } = get();
    for (const tabIds of Object.values(splitState.tabIdsBySplitId)) {
      for (const tabId of tabIds) {
        const view = viewRegistry.getInstance(tabId);
        await view?.close();
        viewRegistry.destroy(tabId);
      }
    }
    set({ splitState: createSplitState() });
  },

  // ... toggleSecondarySplit, etc.
});
```

### Store Composition

```typescript
// Before:
type AppStore = WorkspaceSlice & TerminalSlice & TaskSlice;

// After:
type AppStore = WorkspaceSlice & TaskSlice & SplitSlice;
```

`TerminalSlice` is removed entirely. `WorkspaceSlice` drops `worktreeTerminalIds`.

## React Components (Rendering Layer)

React components receive `{ tab, isVisible }` props from the store. They do **not** call View methods or oRPC for resource creation/destruction.

### Content Renderer

```tsx
// content-renderer.tsx — fully generic, no switch statement
function ContentRenderer({ splitId, tabId }: { splitId: string; tabId: string }) {
  const tab = useAppStore(s => s.splitState.tabs[tabId]);
  const activeTabId = useAppStore(s => s.splitState.activeTabIdBySplitId[splitId]);
  const isVisible = tabId === activeTabId;

  const view = viewRegistry.getInstance(tabId);
  if (!view) return <UnsupportedKindFallback kind={tab.kind} />;

  const Component = view.component;
  return <Component tab={tab} isVisible={isVisible} />;
}
```

### Terminal Renderer

```tsx
function TerminalRenderer({ tab, isVisible }: ViewProps) {
  const { terminalId } = getBuiltinTabState(tab, "terminal");
  return <TerminalView terminalId={terminalId} isVisible={isVisible} />;
}
```

### Diff Renderer

```tsx
function DiffRenderer({ tab, isVisible }: ViewProps) {
  const file = getBuiltinTabState(tab, "diff");
  if (!file) return <EmptyDiffState />;
  return <SingleFileDiff file={file} />;
}
```

### Tab Bar

```tsx
function TabBar({ splitId }: { splitId: string }) {
  const tabIds = useAppStore(s => s.splitState.tabIdsBySplitId[splitId]);
  const activeTabId = useAppStore(s => s.splitState.activeTabIdBySplitId[splitId]);
  const { activateTab, closeTab } = useAppStore();

  return (
    <div>
      {tabIds.map(id => {
        const tab = useAppStore(s => s.splitState.tabs[id]);
        const view = viewRegistry.getInstance(id);
        return (
          <Tab
            key={id}
            icon={view?.icon}
            label={tab.title}
            active={id === activeTabId}
            onClick={() => activateTab(splitId, id)}
            onClose={() => closeTab(splitId, id)}
          />
        );
      })}
      <NewTabMenu kinds={viewRegistry.kinds()} />
    </div>
  );
}
```

## Lifecycle Timeline

### Open Tab

```
User clicks "+" → Terminal
  → Zustand action: openTerminal(worktreeId)
    → 1. Registry:   viewRegistry.createView("terminal")   [factory → new View instance]
    → 2. View:       view.open(worktreeId)
      → 2a.            await orpc.terminal.create()         [create PTY]
      → 2b.            this.terminalId = term.id            [View stores own state]
      → 2c.            return { title, state, key }         [TabInit]
    → 3. Framework:  create TabData from TabInit            [id, kind, title, state]
    → 4. Framework:  viewRegistry.bind(tabId, view)         [internal association]
    → 5. Zustand:    addTab(tab, view.target)               [state update]
    → 6. React:      component mounts                       [render]
    → 7. React:      <TerminalView> attaches xterm          [DOM lifecycle]
```

### Activate Tab

```
User clicks a tab
  → Zustand action: activateTab(splitId, tabId)
    → 1. View:       viewRegistry.getInstance(prevId)?.onDeactivated()
    → 2. View:       viewRegistry.getInstance(tabId)?.onActivated()
    → 3. Zustand:    set(setActiveTab(state, ...))          [state update]
    → 4. React:      prev component: isVisible=false        [props change]
    → 5. React:      next component: isVisible=true         [props change]
```

### Close Tab

```
User clicks "×"
  → Zustand action: closeTab(splitId, tabId)
    → 1. View:       viewRegistry.getInstance(tabId)?.close()
      → 1a.            await orpc.terminal.close()          [close PTY, using own state]
    → 2. Framework:  viewRegistry.destroy(tabId)            [remove instance]
    → 3. Zustand:    set(removeTab(state, ...))             [state update]
    → 4. React:      component unmounts                     [DOM cleanup]
```

View lifecycle runs **before** React state update. Backend cleanup happens while the component may still be mounted (or not — doesn't matter). The principle: **who creates the resource manages its lifecycle**, independent of React rendering.

### Reset (Worktree Switch)

```
User switches worktree
  → Zustand action: resetTabs()
    → 1. View:       close all View instances (batch)       [cleanup backends]
    → 2. Framework:  destroy all instances                   [cleanup registry]
    → 3. Zustand:    set(createSplitState())                 [reset state]
    → 4. React:      all components unmount                  [DOM cleanup]
    → 5. Zustand:    openTerminal(worktreeId)                [seed new terminal]
```

## Comparison with VS Code and Obsidian

### Where We Match

- **Unified registration** (like Obsidian): builtin and plugin use the same `register()` path. VS Code has dual-track (core registry vs Extension API).
- **Per-tab instance** (like Obsidian): each tab gets its own View with isolated state. VS Code reuses EditorPane instances per group.

### Where We Differ (Trade-offs)

| Dimension | VS Code | Obsidian | Ours | Notes |
|-----------|---------|----------|------|-------|
| Per-tab state isolation | ✓ EditorInput instance | ✓ View instance | ✓ View instance | All three use per-tab instances |
| API encapsulation | ✓ Command layer between core/extension | ✗ Direct View access | ✗ Direct View access | VS Code's command layer prevents breakage on refactor. Acceptable for now; add command layer if needed. |
| Builtin type inference | △ Direct import (core only) | ✗ Manual cast `getViewOfType<T>()` | ✓ Overloaded `createView()` / `getBuiltinTabState()` | Our type inference is the strongest, but relies on manually maintained type maps (3 places to update per builtin kind). |
| State type safety (write) | ✓ Class fields | ✗ `Record<string, unknown>` | ✓ `createTab()` overload | Our write-time safety is good but shallow — `TabData.state` is `unknown` at the container level. |
| Lifecycle richness | ✓ dirty/save/revert, confirmSave, preview tab | △ onOpen/onClose, requestSave | ✗ Minimal: open/close/activate/deactivate | We lack dirty state, save/revert, close confirmation, preview tabs. Add when needed. |
| Serialization/restore | ✓ EditorSerializer (separate concern) | ✓ getState/setState (built-in) | △ Optional serialize/restore (not rigorous) | Needs hardening before workspace persistence. |
| Split/group model | ✓ EditorGroupModel (MRU, preview, sticky, lock) | ✓ Recursive nested splits | △ Flat SplitState | Simpler, sufficient for current needs. |

### Honest Assessment

**Strengths over both:**
- Builtin type inference without cast (overloaded `createView()` + `getBuiltinTabState()`)
- Write-time state validation (`createTab()` overload)
- Simpler mental model (plain data + factory instances + React)
- Clean separation: View doesn't know about Tab internals

**Weaker than VS Code:**
- No API encapsulation boundary
- No dirty/save/revert lifecycle
- No preview tab, sticky tab, group lock

**Weaker than Obsidian:**
- Less battle-tested serialization/restore
- No recursive nested split model

**Acceptable trade-offs for current stage:**
- API encapsulation (command layer) — add when needed
- Dirty/save/revert — add when we have editable content types
- Preview tabs — add when we have file-based content

### Resolved Gaps

**Gap 1 (resolved): Data layer thickness — plain object vs behavioral class**

Decision: **Tab stays plain data in the normalized store.** View handles all behavior.

Rationale:
- VS Code's `EditorInput` is a class because VS Code doesn't use React/Zustand — it manages its own change notifications. We use Zustand for reactivity, so data must be plain serializable objects.
- The Zustand store is vanilla (`zustand/vanilla`), usable from JS — so View can read/write the store directly if needed. But View doesn't need Tab data because it manages its own runtime state.
- `isDirty()` (VS Code's EditorInput method) would belong on View, not Tab — it's runtime state, not persistent data.
- A PaneLeaf class wrapping store data would create two instance systems per tab (class + View) with initialization and sync complexity, for no clear benefit.

### Closed Gaps

**Gap 2 (closed): Multi-input matching — not needed**

VS Code's pattern scoring (one Pane handles multiple Input types) solves a problem we don't have. Our 1:1 kind → View mapping is sufficient. Each content type gets its own View class.

**Gap 3 (deferred): View replacement within a tab — not considering now**

Obsidian supports in-place View swap (`leaf.setViewState()`). Mechanically straightforward in our architecture (destroy old View, create new View, rebind same tabId, update Tab data), but no current use case justifies it. Revisit when needed.

**Gap 4 (closed): Global lifecycle events — Zustand covers it**

VS Code and Obsidian need global event buses (`onDidChangeActiveEditor`, `workspace.on('active-leaf-change')`) because extensions are decoupled from core state. We don't need a separate event system — Zustand `store.subscribe(selector, callback)` already provides reactive global state observation. Instance-level hookable covers per-View lifecycle.

## Extending With New Kinds

### Builtin Kind

Adding a new builtin kind (e.g., "settings"):

1. Add `"settings"` to `BuiltinTabKind` union
2. Add `settings: SettingsState` to `BuiltinTabStateMap`
3. Add `settings: SettingsView` to `BuiltinViewMap`
4. Create `SettingsView extends View` — implement `open`, `close`, `component`
5. Register: `viewRegistry.register("settings", () => new SettingsView())`
6. Optionally add `openSettings()` convenience action in SplitSlice

No changes to `split-state.ts`, `ContentRenderer`, `ViewRegistry`, or any existing kind.

### Extensibility

The registry pattern naturally supports new kinds beyond builtins. Any code can call `viewRegistry.register(kind, factory)` with the same API used for terminal and diff. The `unregister()` method exists for cleanup. No plugin system is designed here — just a uniform registration mechanism that will accommodate one if needed later.

## Mode A (Grouped) Rendering

```
activeTab = "terminal-abc123"
activeKind = "terminal" (derived from tabs[activeTab].kind)

Group bar:  [Terminal*] [Diff]           ← derived from unique kinds in tab ID list
Sub bar:    [Terminal 1*] [Terminal 2]    ← filtered tab IDs where kind === activeKind
Content:    <TerminalView id="abc123" /> ← rendered from active tab's state
```

Group switching uses `lastActiveTabByKind` to restore position within each group.

## Mode B (Flat) Rendering

```
activeTab = "terminal-abc123"

Tab bar:    [Terminal 1*] [Terminal 2] [README.md] [package.json]
Content:    <TerminalView id="abc123" />
```

## Open Questions

1. **Tab ordering in flat mode:** Freely reorderable, or sorted by kind then insertion order? (Deferred — insertion order for now.)
2. **New tab UX for terminals:** "+" directly creates a new terminal instance in flat mode.
3. **New tab UX for diffs:** Remove "Diff" from "+" menu — diffs are opened from the sidebar.
4. **Tab limit:** Max tabs per split? (Deferred — not needed yet.)
5. **Tab persistence:** Persist tab configuration across worktree switches? (Keep current behavior: reset.)
6. **Multi-terminal seeding:** Reconcile with `orpc.terminal.list` on worktree switch, or seed single terminal? (Start with single.)
7. **Tab deduplication:** When `open()` produces a tab ID that already exists (e.g., re-opening the same diff file), should the framework focus the existing tab or create a duplicate? (Likely: focus existing, but needs explicit handling in `openTerminal`/`openDiff`.)
8. **Error handling in `open()`:** If `view.open()` fails (e.g., PTY creation error), the View instance was created but never bound. The framework needs rollback — destroy the View instance and surface the error. Currently not specified.

## Affected Files

| File | Change |
|------|--------|
| **New: `views/view.ts`** | View class (extends Hookable), ViewProps, ViewHooks, TabInit |
| **New: `views/view-registry.ts`** | ViewRegistry class (factories + instances), BuiltinViewMap |
| **New: `views/terminal-view.ts`** | TerminalView class |
| **New: `views/diff-view.ts`** | DiffView class |
| **New: `components/terminal-renderer.tsx`** | React component for terminal content |
| **New: `components/diff-renderer.tsx`** | React component for diff content |
| **New: `types/tab.ts`** | TabData, TabKind, BuiltinTabKind, BuiltinTabStateMap, createTab, getBuiltinTabState |
| **New: `stores/slices/split-slice.ts`** | Zustand SplitSlice with framework orchestration |
| `split-state.ts` | Normalized SplitState (`tabs` record + `tabIdsBySplitId`), update pure functions |
| `split-state.test.ts` | Update tests for normalized model |
| `pane-tabs.tsx` → `tab-bar.tsx` | Read tab IDs from store, look up View for icon/metadata |
| `pane-leaf.tsx` → `content-renderer.tsx` | Generic renderer via `viewRegistry.getInstance(tabId).component` |
| `split-pane.tsx` | Simplified — reads from store directly |
| `App.tsx` | Remove all split/tab handler logic (moved to SplitSlice), remove seeding useEffect |
| `terminal-panel.tsx` | **Delete** — replaced by TerminalView + TerminalRenderer |
| `stores/slices/terminal-slice.ts` | **Delete** — replaced by SplitSlice |
| `stores/slices/workspace-slice.ts` | Remove `worktreeTerminalIds`, `addWorktreeTerminal`, `removeWorktreeTerminal` |
| `stores/slices/index.ts` | Remove TerminalSlice re-export, add SplitSlice |
| `stores/app-store.ts` | `AppStore = WorkspaceSlice & TaskSlice & SplitSlice` |
| `components/terminal/index.ts` | Remove TerminalPanel export, keep TerminalView |
