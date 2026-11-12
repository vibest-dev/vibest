# Subscriptions: where login and usage come from

How the harness adapters fill a Subscription (architecture D10, §3, §8 Usage and Availability, §9), checked on
one machine on 2026-10-31 against Claude Code 2.1.316, Pi 1.4.0 and cursor-agent 2026.10.22. Prototype parsers:
`packages/core/src/subscriptions/` (not wired in). Answers open question 2 of the architecture: **an adapter
capability per harness.** No shared source exists: herdr 0.9.5 has no `agent-quota` plugin installed
(`~/.config/herdr/plugins.json` lists only `session-label`), and none was found in the local herdr checkouts.

**Verified** means seen on this machine in a real response. **Assumed** means read from code, docs or field names
and not seen.

## Adapter contract

```ts
subscription(): Effect<Subscription, never>            // one per (harness, provider, machine)
interface Subscription { account: Account; limits: ReadonlyArray<Limit> }
interface Account { kind: "subscription" | "api-key" | "none"; plan?: string; provider?: string }
interface Limit { window: string; percent: number /* 0–100 */; status: "available" | "limited"; resetTime: number | null /* epoch ms */ }
```

- A Subscription is per `(harness, provider, machine)`. `provider` is empty for a single-login harness (Claude
  Code, Cursor) and set for Pi (one login per provider).
- The adapter reads the source; the pure parsers (`claudeAccount`, `cursorAccount`, …) turn it into this shape.
  A failed read never fails the Effect: it keeps the last Subscription and the core records its age in
  `time.update`. Plugins decide what a stale reading is worth.
- Usage limits come only from official or CLI-provided sources. `limits: []` means unknown, not unlimited, and
  that is fine when a harness offers none. An API-key login has none; such an Agent only learns of a limit when
  its execution fails (`agent.fail`, reason `limited`).
- Two refresh paths per harness: a **poll** (no Agent needed, D10 asks for every harness on every machine) and
  **push** from a running Agent's integration plugin, which is fresher and free. Push overrides poll until the next poll.
- vibestd keeps the rows in memory, one per `(harness, provider, machine "local")`. It polls once as it starts; after
  that a `list` whose rows are a minute old or more polls first: one poll at a time, shared by every reader, and a
  reader waits at most the CLI timeout for it before it gets the stored rows. Nothing polls while nobody reads. A CLI
  read runs with stdin closed and stderr discarded, for at most 10 s. A defect in a poll is not a failed read either:
  the row stays, and its message carries no token.
- vibest does not read a harness credential file or keychain item, and it does not call a usage API. Claude and
  Cursor report a login and no usage limits. A plugin may report limits; the next poll of those two replaces them
  with `[]`.

## Claude Code

|             | Source                                                                                                                                              | Fields                                                                                                                                        | Freshness                       | Status   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- |
| Login       | `claude auth status --json` (`--json` is the default)                                                                                               | `loggedIn`, `authMethod` (`claude.ai`), `apiProvider` (`firstParty`), `subscriptionType` (`max`); also `email`, `orgId`, `orgName` (not kept) | live, local, no network, ~0.5 s | verified |
| Usage, poll | none. vibest does not read Claude's OAuth token, `~/.claude/.credentials.json`, or the Anthropic usage API. `limits` stays `[]` (unknown, not full) | —                                                                                                                                             | —                               | —        |
| Usage, push | none from the adapter. A plugin may still report limits; the next poll replaces them with `[]`                                                      | —                                                                                                                                             | —                               | —        |

Failure modes: not signed in (`loggedIn: false`); API key, `apiKeyHelper`, Bedrock or Vertex (`authMethod` other
than `claude.ai` is an API-key login, with no windows). A failed `claude auth status` keeps the last row.

## Cursor (`cursor-agent`)

|             | Source                                                                                                                      | Fields                                                                                 | Freshness                 | Status   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- | -------- |
| Login       | `cursor-agent status --format json`                                                                                         | `isAuthenticated`, `status` (`authenticated`), `hasAccessToken`, `userInfo` (not kept) | live, network check, ~1 s | verified |
| Plan        | `cursor-agent about --format json`                                                                                          | `subscriptionTier` (`Ultra`)                                                           | live                      | verified |
| Usage, poll | none. vibest does not read Cursor's keychain access token or call `api2.cursor.sh`. `limits` stays `[]` (unknown, not full) | —                                                                                      | —                         | —        |
| Usage, push | none from the adapter. A plugin may still report limits; the next poll replaces them with `[]`                              | —                                                                                      | —                         | —        |

On macOS, both Cursor model discovery and subscription probes require a regular file at
`HOME/Library/Keychains/login.keychain-db` before starting its CLI. An empty Keychains directory is not enough.
A missing login keychain reports Cursor unavailable rather than starting its default-keychain
write probe, which can open a system dialog even for `--version`. Child commands keep the inherited environment
and use the checked HOME. This does not create, unlock or change a keychain, and does not detect a locked
keychain or a process outside the login security session. The check only looks for that file; it does not read a keychain item.

Failure modes: not signed in (`isAuthenticated: false`). A failed `cursor-agent status` keeps the last row.

## Pi

vibest's Pi adapter asks `pi --list-models` for providers (the first column; `No models available` is an empty
list), then login readiness with `pi auth check --provider <p> --json --no-refresh` for each. It does not read Pi's
files. If the list command does not answer, the read is an error. Pi has no usage command. Usage limits come from plugins: any vibest plugin may report a Subscription's limits (for example
a user's plugin that reads a provider's usage). vibest does not parse Pi provider response headers. With no such
report, limits stay unknown (`[]`). Login is per provider, so `provider` is set. Pi refuses `--provider` without
`--model`: a move to a Pi login with no model records the login on the session and starts Pi on its default.

|       | Source                                             | Fields                                                                                                                                                          | Freshness         | Status                                                                                                                                                            |
| ----- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login | `pi auth check --provider <p> --json --no-refresh` | `status` (`ready`, `not_ready`), `provider`, `authType` (`api_key`; OAuth value assumed `oauth`), `reason` (`credentials_not_configured`, `provider_not_found`) | live, local, ~1 s | verified for a custom `api_key` provider and `cpamp` (ready, `api_key`), `anthropic`, `openai-codex` (`credentials_not_configured`), `cpa` (`provider_not_found`) |
| Usage | none from the adapter                              | —                                                                                                                                                               | —                 | a plugin may report limits; otherwise unknown (`[]`)                                                                                                              |

`--no-refresh` keeps `pi auth check` from refreshing OAuth tokens (it refreshes and writes `auth.json` by
default). Exit status is 0 for `not_ready` too: read the JSON.

Failure modes: `pi --list-models` not answering; `provider_not_found` when the list names a provider `pi auth check`
does not load (an extension's provider).

## Summary

| Harness     | Login                                                                                                                                   | Usage                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Claude Code | `claude auth status --json`: verified                                                                                                   | none from the adapter (`[]` unknown, not full)                   |
| Cursor      | `status` + `about --format json`: verified                                                                                              | none from the adapter (`[]` unknown, not full)                   |
| Pi          | `pi --list-models`, then `pi auth check --json --no-refresh` per provider: verified (API-key providers), OAuth `authType` value assumed | none from the adapter (`[]` unknown); a plugin may report limits |

Limits come only from official or CLI-provided sources; a harness with none keeps `limits: []` (unknown). One
Subscription per `(harness, provider, machine)`: `provider` empty for Claude Code and Cursor, set for Pi. vibest
does not read a harness token. Claude and Cursor keep `limits: []`.

Blockers before wiring in:

1. Unverified values: Pi OAuth `authType`, Claude non-`claude.ai` `authMethod` values. Each needs one
   signed-in account to confirm.
