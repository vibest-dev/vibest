# React-scan Integration Design

**Date:** 2026-02-02
**Target:** Desktop Renderer
**Goal:** Integrate react-scan for performance visualization and debugging

## Overview

Integrate react-scan into the desktop renderer to provide real-time performance monitoring during development. React-scan will highlight component re-renders, detect unnecessary renders, and provide console diagnostics to help identify performance bottlenecks.

## Configuration

**Dependency:**
- Add `react-scan` as dev dependency to `apps/desktop`
- Installation: `pnpm add react-scan -D --filter desktop`

**Settings:**
- `enabled`: Controlled by `import.meta.env.DEV` (development-only)
- `showToolbar`: `true` (draggable UI for runtime control)
- `animationSpeed`: `"fast"` (visible but not distracting)
- `log`: `true` (console output for render tracking)
- `trackUnnecessaryRenders`: `true` (detect renders with no DOM changes)

## Implementation

### Critical Requirement

React-scan must hijack React DevTools hooks before React initializes. This requires importing and configuring react-scan BEFORE any React imports in the entry point.

### File Changes

**`apps/desktop/src/renderer/src/main.tsx`:**

```typescript
// CRITICAL: react-scan must be imported FIRST, before React
import { scan } from 'react-scan'

// Configure react-scan before any React imports
if (import.meta.env.DEV) {
  scan({
    enabled: true,
    showToolbar: true,
    animationSpeed: 'fast',
    log: true,
    trackUnnecessaryRenders: true,
  })
}

// NOW import React and other dependencies
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// ... rest of imports and app initialization
```

### Import Order

1. `react-scan` import and configuration
2. React imports (`react`, `react-dom`)
3. Application imports
4. Render logic

Breaking this order will cause react-scan to fail silently.

## Verification

### Visual Indicators

When running `pnpm dev --filter desktop`, the following should be visible:

- **Toolbar:** Draggable UI element (typically bottom-right)
- **Render highlights:** Colored outlines flash on component re-renders
- **Color coding:** Cooler colors (blue) = infrequent, warmer colors (red) = frequent

### Console Output

With `log: true`, expect console messages:

```
[react-scan] Component rendered: <ComponentName>
[react-scan] Unnecessary render detected in <ComponentName>
```

### Toolbar Features

- Toggle scanning on/off
- View render statistics per component
- Inspect individual render causes
- Performance bell icon for insights
- Drag to screen edges to collapse

### Expected Behavior

Areas likely to show render activity:
- **Terminal components:** Active during typing/output
- **Sidebar navigation:** Highlights on route changes
- **Dialogs:** Render on open/close
- **Task/worktree lists:** Update on state changes

## Development Workflow

1. Start dev server: `pnpm dev --filter desktop`
2. Open Electron app
3. Interact with UI to trigger renders
4. Observe toolbar and console for performance data
5. Use insights to identify optimization opportunities

## Success Criteria

- [ ] React-scan toolbar visible in dev mode (requires running app to verify)
- [ ] Component renders highlighted with colored outlines (requires running app to verify)
- [ ] Console logs show render activity (requires running app to verify)
- [ ] Unnecessary renders detected and reported (requires running app to verify)
- [x] No performance impact in production builds (react-scan only enabled in dev mode)
- [x] Type safety maintained (TypeScript errors = 0)

## Notes

- React-scan only runs in development mode (Vite's `import.meta.env.DEV`)
- Production builds remain unaffected (no bundle size impact)
- Toolbar can be hidden by dragging to screen edges
- Fast animation speed balances visibility with minimal distraction
