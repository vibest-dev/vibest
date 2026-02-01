---
status: done
priority: p1
issue_id: "005"
tags: [code-review, performance, memory-leak]
dependencies: []
---

# Memory Leak - WebGL Addon Not Disposed on Unmount

## Problem Statement

The WebGL addon for xterm.js is created but the reference is lost after initialization. When the component unmounts, the WebGL context is not properly released, causing GPU memory leaks.

**Why it matters:** Each terminal leaks a WebGL context. WebGL context limits (typically 8-16 per page) will be exceeded with many terminals, causing silent fallback to canvas or crashes.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx:65-73`

```typescript
try {
  const webglAddon = new WebglAddon();  // Reference lost after this block
  webglAddon.onContextLoss(() => {
    webglAddon.dispose();
  });
  terminal.loadAddon(webglAddon);
} catch {
  console.warn("WebGL addon failed, using canvas renderer");
}
```

The cleanup function (lines 132-141) disposes the terminal but not the WebGL addon specifically.

**Projected impact at scale:**
- 10 terminals → Approaching WebGL context limit
- 20 terminals → Context creation fails, performance degrades

## Proposed Solutions

### Option A: Store webglAddon in ref and dispose (Recommended)
- **Pros:** Explicit cleanup, standard pattern
- **Cons:** Additional ref to manage
- **Effort:** Small
- **Risk:** Low

```typescript
const webglAddonRef = useRef<WebglAddon | null>(null);

// In initialization:
const webglAddon = new WebglAddon();
webglAddonRef.current = webglAddon;

// In cleanup:
webglAddonRef.current?.dispose();
webglAddonRef.current = null;
```

### Option B: Rely on terminal.dispose() to clean up addons
- **Pros:** Simpler
- **Cons:** May not properly release WebGL context
- **Effort:** None (current behavior)
- **Risk:** Medium (depends on xterm.js internals)

## Recommended Action

*(To be filled during triage)*

## Technical Details

**Affected files:**
- `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx`

## Acceptance Criteria

- [ ] WebGL addon stored in ref
- [ ] Addon explicitly disposed in cleanup
- [ ] No WebGL context leaks after opening/closing terminals
- [ ] Test with 10+ terminals to verify

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | WebGL contexts are limited system resources |
| 2026-02-01 | Fixed: store webglAddon in ref and dispose before terminal.dispose() | Dispose addon explicitly to release GPU context |

## Resources

- [xterm.js WebGL addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)
