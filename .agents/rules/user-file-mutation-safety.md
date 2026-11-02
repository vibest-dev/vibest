# User File Mutation Safety

Any operation, command, or integration that writes to or modifies user files outside `~/.vibest` (or `$VIBEST_HOME`) — for example `~/.pi/agent/settings.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/cli-config.json`, or shell configuration files — must:

1. Display the absolute path of the target file.
2. Display a unified before/after diff showing exactly which lines are added, modified, or removed.
3. Require explicit interactive confirmation (`[y/N]`), proceeding only when the user enters `y` or `Y`.
4. On decline, timeout, EOF, or a non-interactive terminal (non-TTY), abort and leave the target file byte-identical.
5. Write atomically, with a backup or verified rollback on failure.

Files inside `~/.vibest` (or `$VIBEST_HOME`) are internal runtime state owned by vibest and are exempt from this confirmation.

Status: applies from the start. vibest's harness plugins are never installed (they load at launch), so today vibest writes no user file outside its home.
