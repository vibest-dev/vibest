# Builtin skills

Agent Skills (`<name>/SKILL.md`, `name` and `description` frontmatter) for vibest's main agent: `delegate` (dispatch with `vibest run`, track with `vibest ls`, read `vibest result`, follow up with `vibest send`) and `pipeline` (plan, implement, review, pull request).
Each subagent result arrives in the main agent's inbox by itself. The user stays in the loop and may step into any pane.

Each harness integration links `skills` to `packages/skills` in the source tree (`packages/integration/claude/skills`, `packages/integration/cursor/skills`, `packages/integration/pi/src/skills`). `apps/vibest/scripts/build-harnesses.ts` dereferences those symlinks and copies `delegate` and `pipeline` into `harnesses/<harness>/skills/`. That directory is part of the `harnesses/` bundle the npm package and the release archive already ship. Nothing is written into the user's harness config; the plugins load at launch.

In Pi, the `@vibest/pi` extension returns `skillPaths` from `resources_discover` only when `VIBEST_AGENT=coordinator` (the main agent), and Pi does not receive `--no-skills`, so the user's own Pi skills stay loaded and Pi subagents do not get `delegate` or `pipeline`. In Claude Code and Cursor, `--plugin-dir` loads the plugin's `skills/` directory and neither CLI has a supported setting to turn off only a loaded plugin's skills for a subagent launch, so every Claude and Cursor session sees them and each skill's `description` states that it is only for vibest's main agent.

Plain files: the copy is the build, not a package.
