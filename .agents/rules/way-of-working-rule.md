# Way of Working Rule

1. Main path first. Edge cases are listed as known limits, not chased, unless the owner asks.
2. Prove behaviour with E2E in a World (`tools/e2e/src/world.ts`: temp `VIBEST_HOME`, its own herdr session), never against the user's real vibest home or herdr session. A check whose pane shell must not read the user's zshrc passes an empty `ZDOTDIR`. How to run the gates: [AGENTS.md](../../AGENTS.md#verifying-a-change).
3. Behaviour choices are put to the owner before they are built.

Status: in force. A World does not set `ZDOTDIR` itself; `tools/e2e/src/scenarios/integration.ts` passes it per command.
