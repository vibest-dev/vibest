# Harnesses and models

The coding agents (harnesses) vibest runs: Claude, Pi and Cursor. Each capability below says what it is and when it
counts as working.

## H1. Listing harnesses

`vibest harness list` shows one entry per harness (Claude, Pi, Cursor) with its binary, whether it can start, and its
default model. A harness whose CLI is missing says so.

## H2. Listing models

`vibest harness models <harness>` and `vibest models` list a non-empty set of models for each installed harness; a
harness that is not installed is left out.

## H3. Doctor

`vibest doctor` groups what it checks (coding agents, herdr, vibestd, plugins), puts a line saying how to fix each
problem under it, and ends with a verdict: one line per harness, and a herdr line for each harness that can run.

## H4. Cursor probes on a home without a login keychain

On macOS, vibest never starts Cursor to discover models or read its usage when the home has no login keychain, and it
does not carry SSH session settings into a home it switches to.

## H5. A run inherits the caller's harness

`vibest run` without a harness takes the caller's harness, provider and model: from the session that runs it. Naming a
harness drops the provider and model.

## H6. `vibest` reuses the entry session's last harness

`vibest` without `--harness` starts the harness the project's entry session last used. A project's first start without
`--harness` fails and asks for one.
