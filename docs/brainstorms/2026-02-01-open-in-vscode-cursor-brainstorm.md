---
date: 2026-02-01
topic: open-in-vscode-cursor
---

# Open in VSCode/Cursor for Desktop App

## What We're Building

Add two new menu items to the desktop app header dropdown menus: "Open in VSCode" and "Open in Cursor". These appear alongside the existing "Open in Finder" and "Open Terminal" options, available in both the worktree context menu and repository context menu.

When clicked, the corresponding editor opens with the worktree or repository path loaded.

## Why This Approach

**Approaches considered:**

1. **Single menu item with settings toggle** — User picks preferred editor in settings, one "Open in Editor" button appears. Adds settings complexity, less discoverable.

2. **Two separate menu items** — Explicit "Open in VSCode" and "Open in Cursor" options. Simple, no settings needed, both editors accessible.

3. **VSCode only** — Since Cursor uses the same `code` CLI, just add VSCode. But this ignores that Cursor has its own `cursor` CLI and users may have both installed.

**Chosen: Two separate menu items.** Simple to implement, no configuration needed, and respects that users may prefer one editor or have both installed.

## Key Decisions

- **Separate menu items for VSCode and Cursor**: Each editor gets its own clearly-labeled menu option
- **CLI-based approach**: Use `code` CLI for VSCode and `cursor` CLI for Cursor (same pattern as existing `openWorktree`)
- **Silent failure**: Check if CLI exists before attempting; fail quietly if not installed (no intrusive error dialogs)
- **Same placement as Terminal/Finder**: Add to both worktree and repository header menus for consistency
- **Cross-platform support**: macOS first (using `execFile`), follow existing Terminal handler pattern for Windows/Linux if needed

## Implementation Touchpoints

| File | Change |
|------|--------|
| `apps/desktop/src/shared/contract/fs.ts` | Add `openInVSCode` and `openInCursor` to contract |
| `apps/desktop/src/main/ipc/router/fs.ts` | Add handlers using `execFile("code", [path])` and `execFile("cursor", [path])` |
| `apps/desktop/src/renderer/src/components/layout/header.tsx` | Add menu items calling `client.fs.openInVSCode` and `client.fs.openInCursor` |

## Open Questions

- Should we check CLI availability on startup to disable menu items, or just check on click? (Leaning toward check-on-click for simplicity)
- Windows/Linux support: Test `code` and `cursor` CLI behavior on those platforms

## Next Steps

→ `/workflows:plan` for implementation details
