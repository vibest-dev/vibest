# Guard and Memory

1. Under the projects directory the guard allows only the session's own `VIBEST_SCRATCH`. It does not infer anything from path shapes: project keys contain slashes.
2. Every new path that opens a terminal passes the session key, so `VIBEST_SCRATCH` is set.
3. The guard and memory will be redesigned. Until then, do not extend guard rules ad hoc.

Status: in force on main (`packages/core/src/guard.ts`; `VIBEST_SCRATCH` is set by `openTerminal` in `packages/core/src/placement.ts`).
