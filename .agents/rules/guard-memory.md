# Guard and Memory

1. Under the projects directory the guard allows only the session's own project folder, `VIBEST_PROJECT_DIR` (`projects/<project id>`): every agent reads and writes it with its own file tools, and nothing else there. It does not infer anything from path shapes: a project folder is named by its project id.
2. The coordinator writes files only inside `VIBEST_PROJECT_DIR`; its pre-tool hook refuses every other file edit. A subagent gets the folder without permission prompts (Claude: `--add-dir` and `Read`/`Edit` allow rules limited to it).
3. Every new path that opens a terminal passes the session key, so `VIBEST_PROJECT_DIR` is set. Its subfolders are fixed: `docs/`, `memories/`, `artifacts/`.
4. The guard and memory will be redesigned. Until then, do not extend guard rules ad hoc.

Status: in force on main (`packages/core/src/guard.ts`; `VIBEST_PROJECT_DIR` is set by `vibestEnv` in `packages/core/src/sessions.ts` and, for the coordinator, `coordinatorCommand` in `packages/core/src/launch.ts`).
