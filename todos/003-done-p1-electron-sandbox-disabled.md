---
status: done
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

**Location:** `apps/desktop/src/main/electron/main-window.ts`

Previously reported at `apps/desktop/src/main/index.ts` before the desktop runtime refactor.

## Resolution

Sandbox is enabled in production BrowserWindow configuration:

```typescript
webPreferences: {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
},
```

Verified during architecture review 2026-08-20.

## Work Log

| Date       | Action                                               | Learnings                                                       |
| ---------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| 2026-02-01 | Identified via code review                           | Electron security best practices require sandbox                |
| 2026-02-01 | Fixed: enabled sandbox: true, contextIsolation: true | Preload already uses contextBridge pattern                      |
| 2026-02-01 | Reverted: sandbox breaks @electron-toolkit/preload   | Need to rewrite preload without external deps to enable sandbox |
| 2026-08-20 | Verified fixed in main-window.ts                     | Desktop AGENTS.md security section matches current config       |

## Resources

- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security)
