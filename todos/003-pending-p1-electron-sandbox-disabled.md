---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, security, electron]
dependencies: []
---

# Electron Sandbox Disabled

## Problem Statement

The Electron webPreferences explicitly disable the sandbox, removing a critical security boundary between the renderer and the system.

**Why it matters:** If the renderer process is compromised (e.g., via XSS or malicious content), the attacker gains significantly more capabilities without sandbox isolation.

## Findings

**Location:** `apps/desktop/src/main/index.ts:23-26`

```typescript
webPreferences: {
  preload: join(__dirname, "../preload/index.mjs"),
  sandbox: false,  // <-- PROBLEM
},
```

## Proposed Solutions

### Option A: Enable sandbox (Recommended)
- **Pros:** Significantly reduces attack surface
- **Cons:** May require refactoring preload script to use contextBridge
- **Effort:** Medium
- **Risk:** Low (standard Electron security practice)

```typescript
webPreferences: {
  preload: join(__dirname, "../preload/index.mjs"),
  sandbox: true,
  contextIsolation: true,  // Verify this is enabled
  nodeIntegration: false,  // Explicit
},
```

### Option B: Document the exception
- **Pros:** None
- **Cons:** Leaves security gap, bad practice
- **Effort:** Small
- **Risk:** High (security debt)

## Recommended Action

*(To be filled during triage)*

## Technical Details

**Affected files:**
- `apps/desktop/src/main/index.ts`
- Potentially `apps/desktop/src/preload/` if refactoring needed

## Acceptance Criteria

- [ ] `sandbox: true` in webPreferences
- [ ] `contextIsolation: true` verified
- [ ] Preload script uses contextBridge pattern
- [ ] App functionality verified after change

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | Electron security best practices require sandbox |
| 2026-02-01 | Fixed: enabled sandbox: true, contextIsolation: true | Preload already uses contextBridge pattern |
| 2026-02-01 | Reverted: sandbox breaks @electron-toolkit/preload | Need to rewrite preload without external deps to enable sandbox |

## Resources

- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
