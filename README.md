# vibest

A CLI agent orchestrator: a coordinator directing Pi, Claude Code and Cursor sessions in herdr panes.

## Install

```sh
curl -fsSL https://github.com/vibest-dev/vibest/releases/latest/download/install.sh | sh
```

This installs into `~/.local/share/vibest` and links `~/.local/bin/vibest`; no Node needed. Or with npm:

```sh
npm i -g @vibest/cli@beta
```

`vibest update` updates it the same way it was installed and, after a yes, replaces the running vibestd while your agents keep running (queued messages wait for the new one; `vibest daemon restart` does the same on its own). `vibest`, `vibest status` and `vibest doctor` say once a day when a newer vibest is out (`VIBEST_NO_UPDATE_CHECK=1` turns that off). `vibest doctor` checks each harness.

## Cursor shell approval

In a vibest Cursor session, the agent runs `vibest report` to send progress. With `approvalMode: "allowlist"` (Cursor’s default), Cursor asks you to approve that shell command, and the session shows `blocked` until you answer. Choose **Add to allowlist** in the prompt to save the permission in your own Cursor config so it does not ask again.

You can also add `"Shell(vibest report)"` to `permissions.allow` in `~/.cursor/cli-config.json` ahead of time, keeping your existing entries. Cursor matches a command that starts with the pattern followed by a space, so the rule covers `vibest report` with its message argument. With `approvalMode: "unrestricted"`, there is no approval prompt.

Only progress reports wait for this approval. The final result is reported through the `afterAgentResponse` hook and does not depend on it. vibest does not write your Cursor config or pass `--force`; shell approval stays under your control.

Developing vibest: see [AGENTS.md](AGENTS.md).
