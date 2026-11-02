# vibest

A CLI agent orchestrator: a coordinator directing Pi, Claude Code and Cursor sessions in herdr panes.

## Install

```sh
curl -fsSL https://github.com/iamdin/vibest/releases/latest/download/install.sh | sh
```

This installs into `~/.local/share/vibest` and links `~/.local/bin/vibest`; no Node needed. Or with npm:

```sh
npm i -g @vibest/cli@beta
```

`vibest update` updates it the same way it was installed and, after a yes, replaces the running vibestd while your agents keep running (queued messages wait for the new one; `vibest daemon restart` does the same on its own). `vibest`, `vibest status` and `vibest doctor` say once a day when a newer vibest is out (`VIBEST_NO_UPDATE_CHECK=1` turns that off). `vibest doctor` checks each harness.

Developing vibest: see [AGENTS.md](AGENTS.md).
