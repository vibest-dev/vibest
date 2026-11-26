# Builtin skills

Agent Skills (`<name>/SKILL.md`, `name` and `description` frontmatter) for vibest sessions: `delegate` (dispatch with `vibest run`, track with `vibest ls`, read `vibest result`, follow up with `vibest send`), `pipeline` (plan, implement, review, pull request), and `mcp` (inspect/call MCP servers, run Psychoscript CodeMode via `vibest mcp exec`, handle `ToolOutput` spills, and manage `vibest auto` automations).
Each subagent result arrives in the entry session's inbox by itself. The user stays in the loop and may step into any pane.

Each harness integration links `skills` to `packages/skills` in the source tree (`packages/harness-claude/skills`, `packages/harness-cursor/skills`, `packages/harness-pi/src/skills`, `packages/harness-agy/skills`). `packages/cli/script/build-harnesses.ts` dereferences those symlinks and copies `delegate`, `pipeline`, and `mcp` into `harnesses/<harness>/skills/`. That directory is part of the `harnesses/` bundle the npm package and the release archive already ship. Nothing is written into the user's harness config; the plugins load at launch.

In Pi, the `@vibest/harness-pi` extension returns `skillPaths` from `resources_discover` in every vibest session, and Pi does not receive `--no-skills`, so the user's own Pi skills stay loaded. In Claude Code and Cursor, `--plugin-dir` loads the plugin's `skills/` directory and neither CLI has a supported setting to turn off only a loaded plugin's skills for a subagent launch, so every Claude and Cursor session sees them.

Plain files: the copy is the build, not a package.
