# Content Panel Files — Design

## Status

Approved design for the first implementation of read-only workspace file browsing in the Content Panel.

The work lives in:

- Worktree: `/Users/dinq/Code/vibest-dev/feat-content-panel-file-explorer`
- Branch: `feat/content-panel-file-explorer`

All current and subsequent changes remain uncommitted until implementation and verification are complete and the user explicitly approves a commit.

## Goal

Replace the mock File Panel with a real read-only workspace browser while preserving the existing Content Panel model:

- Keep a singleton Files Tab as the entry point before a file is open.
- Replace the Files Tab with the first file selected from it.
- Open additional files simultaneously, with one Content Panel Tab per file.
- Render the active file on the left and the workspace file tree on the right.
- Use `@pierre/diffs` for read-only file rendering.
- Use `@pierre/trees` for the file tree.

## Existing Panel Semantics

Keep the existing `filePanel` identity and payload contract:

```ts
{
  type: "file",
  key: payload.path,
  payload: {
    path: string,
    line?: number,
  },
}
```

Consequences:

- Each path identifies one file Tab.
- Clicking the first path from the Files Tab replaces that Tab record in place with the selected file, so there is no intermediate extra Tab and the resulting identity is the normal `file:<path>` identity.
- Clicking a later path that is not open creates a Tab.
- Clicking a path that is already open activates the existing Tab.
- Multiple different paths can remain open simultaneously.
- Existing reload restoration continues to use the path payload.

The Content Panel host remains the only owner of the Tab strip. Files must not introduce a nested Tab system.

## Layout

### Files Tab

The singleton Files Tab uses the same split workspace layout as a file Tab. The left preview area uses the Coss UI Empty composition with an icon media, title (`打开文件`), and description (`从工作区目录树中选择文件`), while the workspace file tree remains on the right. Selecting a file replaces the Files Tab in place with the normal path-keyed file panel.

### File Tab

A file Tab uses a split workspace layout:

```text
┌──────────────────────────────┬──────────────────────┐
│ Read-only file preview       │ Workspace file tree  │
│ @pierre/diffs                │ @pierre/trees        │
│                              │                      │
└──────────────────────────────┴──────────────────────┘
```

- File preview is on the left.
- File tree is on the right.
- A draggable splitter adjusts the right-side tree width.
- Splitter width is local component state only.
- Splitter width is not shared between the Files entry view and file Tabs.
- Splitter width is not preserved across component unmounts or page reloads.

### Narrow Screens

Use the app's existing responsive breakpoint conventions.

- A file Tab gives the preview the full panel width.
- The file tree moves into a right-side drawer.
- The drawer is opened explicitly from the file preview UI.
- The Files Tab shows the empty preview at full width and moves its file tree into the same right-side drawer used by file Tabs.

## File Tree Data Strategy

### Complete Path Input

`@pierre/trees` does not expose a first-class asynchronous `loadChildren` or `onExpand` data-source interface. Its public FileTree interface is designed around a known path list or prepared input.

The first implementation therefore builds a complete workspace path list and passes it to Pierre.

Virtualization is still valuable for limiting rendered DOM rows, but it does not replace filesystem indexing.

### Filesystem Scan

The server recursively scans the workspace:

- Confinement is enforced against the normalized workspace root.
- Directory reads use finite concurrency.
- Paths are returned in canonical POSIX-style relative form.
- Directories are represented in the form expected by Pierre.
- No filesystem watcher is introduced.
- No silent maximum-entry truncation is introduced.
- Symlinks are never recursively followed.

### Exclusion Policy

The Files view is disk-oriented. It does not apply `.gitignore`.

The scan only prunes dependency and environment trees that are clearly pathological because of their depth and file count.

Directory basenames excluded at any depth:

```text
.git
node_modules
.pnpm-store
.venv
venv
.tox
.nox
.terraform
```

Nested path sequences excluded at any depth:

```text
.yarn/unplugged
vendor/bundle
```

The scan does not automatically exclude ordinary cache or build-output names such as:

```text
.turbo
.vite
.next
dist
build
out
coverage
target
vendor
```

Those names can represent useful or user-maintained content and are not equivalent to `node_modules`.

### Why t3code Is Not the File Tree Reference

The t3code `WorkspaceEntries` index is used by Composer `@path` fuzzy search, not by a workspace Files view.

It can still inform generic implementation mechanics such as finite directory-read concurrency and cache deduplication, but its data policy must not be copied:

- it applies VCS ignore rules;
- it excludes additional build directories;
- it truncates its search index;
- missing entries are acceptable for ranked search.

Those properties are unsuitable for a faithful disk-oriented Files view.

## Pierre Tree Configuration

Keep Pierre-specific behavior inside a Vibest-owned File Tree Adapter so beta API knowledge does not spread across feature code.

Follow the tree package's documented large-tree practices:

```ts
{
  preparedInput,
  initialExpansion: "closed",
  flattenEmptyDirectories: true,
  stickyFolders: true,
}
```

Additional rules:

- Prefer prepared input over repeatedly parsing raw paths during render.
- Use `preparePresortedFileTreeInput` only when the server's final ordering is guaranteed to match Pierre's required canonical ordering.
- Otherwise prepare the raw path list once in the adapter.
- Use Pierre's default sort behavior instead of introducing a Vibest comparator.
- Use Pierre's built-in virtualization.
- Do not override `itemHeight`, `overscan`, density, or virtualization-window behavior in the first implementation.
- Do not enable tree search, drag-and-drop, renaming, or context menus.
- Theme the tree through Pierre's supported theme/CSS-variable surface.

## Tree State

### Shared Expansion State

Within one session:

- The Files Tab and every file Tab share one logical tree model.
- Directory expansion state is shared.
- Switching between Tabs preserves the current tree expansion state.

The shared state is ephemeral:

- It is not written to localStorage.
- It is not written to the server.
- A page reload starts from the initial collapsed state.

### Tab Activation Does Not Auto-Reveal

Activating a file Tab does not mutate the tree:

- no ancestor auto-expansion;
- no automatic file selection;
- no automatic scrolling;
- no focus transfer.

The tree only changes in response to direct tree interaction or a data refresh.

Clicking a file in the tree still performs the tree's normal selection behavior and opens or activates the corresponding file Tab.

## Symlinks

Symlinks remain visible but are treated as non-recursive leaf entries.

- Never traverse a directory symlink during indexing.
- Show a link decoration so the entry is not confused with an ordinary file.
- A symlink resolving to a regular file inside the workspace may be opened through the existing workspace-confinement checks.
- A directory symlink is not expandable.
- A broken symlink is not openable.
- A symlink resolving outside the workspace is not openable.
- Disabled entries expose the reason through accessible text and a tooltip.

The known residual risk of path-based `realpath`/`stat`/`read` checks is documented as a TOCTOU limitation; the first implementation does not introduce descriptor-based reads.

## File Preview

Keep Pierre-specific behavior inside a Vibest-owned File Preview Adapter.

### Text Files

- Render read-only content with `@pierre/diffs`.
- Use the app's resolved light/dark theme.
- Keep line numbers and syntax highlighting enabled through supported Pierre options.
- When `payload.line` is present, scroll to the target line without taking keyboard focus.
- Mark the target line with both a visual marker and semantic text; color alone must not carry the meaning.

### Binary Files

- Binary files remain visible in the tree.
- Do not pass binary content to Pierre.
- Show `Binary preview unavailable` in the preview area.
- Image, PDF, audio, and video previews are outside the first implementation.

### Large Files

The read-only text preview limit is `2 MiB`.

- A file over the limit is not partially rendered.
- Do not silently truncate content.
- Show the file size and `File too large to preview`.

## Query and Session State

Use TanStack Query for server data and Content Panel/session state for UI state.

### Workspace Tree Query

The logical cache identity is based on the workspace root:

```ts
["fs", "tree", cwd];
```

All Tabs in the same workspace consume the same query result.

### File Content Query

The logical cache identity is based on workspace root and relative path:

```ts
["fs", "file", cwd, path];
```

Two Tabs for different paths have separate content queries. The same path reuses its cached content.

### Session Isolation

Shared File Tree model and expansion state are scoped by the complete authoritative `SessionRef` (`projectId`, `harnessAgentId`, and `sessionId`). A bare `sessionId` is not sufficient identity, and Content Panel state from one session must not leak into another.

## Refresh Policy

The first implementation has two refresh mechanisms:

1. Manual Refresh.
2. Normal TanStack Query refetch when the window regains focus.

Manual Refresh:

- rebuilds the complete workspace path list;
- updates the shared Pierre model;
- reloads the currently active file when applicable.

The first implementation deliberately does not add:

- filesystem watchers;
- proactive tree invalidation after Vibest writes a file;
- proactive file-content invalidation after Vibest writes a file.

## Loading and Error States

### File Tree

- Initial scan pending: show the normal loading state.
- Initial scan failure: show an error state with Retry.
- Refresh with existing data: keep rendering the existing tree and show a small progress indicator.
- Refresh failure with existing data: keep the existing tree and show a non-blocking error with Retry.

### File Preview

- File read failure only replaces the preview area; the tree remains usable.
- The preview error includes Retry.
- If a previously opened file no longer exists, show `File no longer exists`.
- Do not automatically close a Tab whose file was deleted.

## Module Seams

Keep feature code organized under `apps/app/src/features/files/`.

Expected modules:

- Files Panel — Content Panel integration for the singleton Files entry view.
- File Panel — Content Panel integration for path-keyed file Tabs.
- Session File Tree State — owns the shared, ephemeral tree model per session.
- File Tree Adapter — contains all `@pierre/trees` construction, mutation, theming, and event knowledge.
- File Preview Adapter — contains all `@pierre/diffs` rendering and line-target knowledge.
- Session Workspace Query — resolves `sessionId` to the workspace `cwd` without conflating project-query errors with a missing workspace.
- Workspace Filesystem module — enforces workspace confinement and implements scan/read classification.

The adapters should be deep modules: callers provide Vibest domain values and do not need to learn Pierre option shapes or lifecycle constraints.

## Responsive and Accessibility Requirements

- Tree interaction remains keyboard accessible through Pierre.
- Opening a file does not steal focus unnecessarily.
- Target-line indication is not color-only.
- Symlink and unavailable-preview states include semantic text.
- Drawer controls have accessible names and state.
- Splitter uses the project's existing accessible resizable-panel primitive if available.
- Loading indicators do not replace usable stale content.

## Non-Goals

The first implementation does not include:

- editing or saving;
- dirty buffers;
- undo/redo;
- save conflicts;
- filesystem watching;
- auto-reveal of the active file;
- persistent tree expansion state;
- persistent splitter state;
- tree search;
- drag-and-drop;
- rename/delete/create operations;
- context menus;
- image/PDF/media preview;
- Git status decorations;
- `.gitignore`-driven Files filtering.

## Verification

Before requesting approval to commit, run at minimum:

- app typecheck;
- server tests;
- app tests;
- app build;
- lint and formatting checks;
- `git diff --check`;
- React Doctor for the changed frontend scope;
- interactive browser/Electron verification of:
  - replacing the Files Tab with the first selected file;
  - opening multiple files;
  - activating an existing file Tab;
  - shared directory expansion across Tabs;
  - no auto-reveal when switching file Tabs;
  - splitter behavior;
  - narrow-screen drawer behavior;
  - manual refresh;
  - window-focus refresh;
  - missing, binary, oversized, and symlink file states.

## Implementation Status

The implementation now follows this design, including the Pierre-owned adapters, shared session tree model, complete workspace indexing policy, responsive split/drawer layout, and path-keyed file Tabs.
