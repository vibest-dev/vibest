# Identity and Context

1. Every harness gets the same identity environment: `VIBEST_SESSION_ID`, `VIBEST_PROJECT_ID` (the project id, a UUID), `VIBEST_HARNESS`, `VIBEST_RUNTIME`, `VIBEST_PROJECT_DIR` (the project folder), `VIBEST_SCRATCH_DIR` (the per-session scratchpad under `<tmpdir>/vibest-<uid>/<project-id>/<session-id>`, cleaned up on `vibest archive`), `VIBEST_HOME`, `VIBEST_CLI` (the absolute path of the vibest that started vibestd, whose directory the launch puts first on `PATH`; hooks call `"$VIBEST_CLI"`, since a login shell may reorder `PATH`). There is no project key and no override: a project is found by the realpath of its directory. `VIBEST_RUNTIME` carries the terminal when it is known; a subagent env is fixed before its pane opens, so its `VIBEST_RUNTIME` has no terminal.
2. Every request carries every identifier it has, built by one `sessionHeaders` in `@vibest/protocol` (the Claude plugin bundles it): `vibest-protocol`, `vibest-caller`, `vibest-session-id`, `vibest-project-id`, `vibest-harness-session-id`, `vibest-harness`, `vibest-cwd`, `vibest-runtime`, `vibest-plugin-version`, `vibest-repository`.
3. Session id and project id are checked. A missing project id is refused on every transport.
4. The harness session id is recorded, latest wins (Claude's `/clear` changes it).

Status: in force on `main`.
