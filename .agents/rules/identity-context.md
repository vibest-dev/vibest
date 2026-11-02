# Identity and Context

1. Every harness gets the same identity environment: `VIBEST_SESSION_ID`, `VIBEST_PROJECT_ID` (the numeric project id), `VIBEST_AGENT`, `VIBEST_HARNESS`, `VIBEST_RUNTIME`, `VIBEST_SCRATCH`, `VIBEST_HOME`, `VIBEST_COMMAND`. The repository key override is `VIBEST_PROJECT_KEY`.
2. Every request carries every identifier it has, built by one `sessionHeaders` in `@vibest/client`: `vibest-protocol`, `vibest-caller`, `vibest-session-id`, `vibest-project-id`, `vibest-harness-session-id`, `vibest-agent`, `vibest-harness`, `vibest-cwd`, `vibest-runtime`, `vibest-plugin-version`, `vibest-repository`.
3. Session id and project id are checked. A missing project id is refused, on RPC and HTTP.
4. The harness session id is recorded, latest wins (Claude's `/clear` changes it).

Status: decided, being built on `feat/claude-http-transport`. On main, `VIBEST_PROJECT_ID` is still the repository key override (`packages/core/src/worktree.ts`), so do not set it in an agent environment until the branch lands.
