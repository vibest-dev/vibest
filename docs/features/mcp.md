# MCP

vibestd manages Model Context Protocol (MCP) servers from `~/.vibest/mcp.json` and project `.mcp.json`, pooling
connections with scale-to-zero eviction, encrypting OAuth credentials, and compiling `SKILL.md` indexes for agents. Each
capability below says what it is and when it counts as working.

## MCP1. Configuring and listing MCP servers

`vibest mcp add` writes a local or remote MCP server definition to `~/.vibest/mcp.json`; `vibest mcp list` (alias
`vibest mcp ls`) returns the configured servers with their type, exposure mode (`skill` by default), status, and cached
tool count; `vibest mcp remove <server>` (alias `rm`) deletes the server and stops its connection. Values starting with
`!` in headers, bearer tokens, OAuth client secrets, or local environment variables are never executed during config
read, list, or cache fingerprinting — only immediately before opening a connection (`!!` escapes a literal `!`).

## MCP2. Stdio transport, NpxResolver, and process-group cleanup

A local stdio server is spawned with a 16 MiB frame guard, bounded outgoing queue, and stderr tail capture. When its
command is `npx` or `npm exec`, `NpxResolver` resolves the cached `~/.npm/_npx/` binary or JS entrypoint directly (using
a 24-hour cache in `<vibestHome>/cache/npx-bin-cache.json` invalidated on exact semver mismatch) to skip the outer `npm`
parent process. Closing the connection or daemon terminates the entire child process group (`SIGTERM` escalating to
`SIGKILL`) so no grandchild processes leak.

## MCP3. Pooled connections and scale-to-zero idle eviction

Sessions sharing identical server identity (command/URL, args, resolved `cwd`, secret fingerprints, credential ID) share
one pooled connection in `McpPool`; servers that negotiate legacy protocol or refuse the shared handshake fall back
automatically to a private connection. When a pooled slot has zero active holders and zero active event streams, a
cancellable one-shot `Effect.sleep` timer evicts the slot after `idleTimeoutMs` (default 180s for global servers, 60s
for workspace-`cwd` servers) and kills its child process group.

## MCP4. Encrypted credential vault and OAuth 2.1

OAuth tokens and dynamically registered clients are stored fail-closed in `<vibestHome>/mcp-credentials.enc` (`0o600`
atomic temp-write + rename, `AES-256-GCM` with `canonicalServerUrl` bound as AEAD AAD, key from `VIBEST_MCP_VAULT_KEY`
or `0o600` `<vibestHome>/mcp-vault.key`, plus optional macOS Keychain backend). Concurrent 401 refreshes serialize behind
a per-server single-flight mutex comparing `presentedAccess === currentAccess`; transient `408`/`429`/`5xx` failures keep
credentials intact while `invalid_grant`/`invalid_client` invalidate them; `logout` increments a monotonic generation
counter so in-flight refreshes discard their result.

## MCP5. Headless 2-step OAuth and security boundaries

`vibest mcp auth start <server>` runs discovery (Pre-registered -> CIMD SEP-991 -> DCR RFC 7591), starts a loopback
callback listener when available, and returns `{ authorizationUrl, state, expiresAt }` while holding the PKCE verifier
in memory (5-minute TTL). `vibest mcp auth complete <server> <redirect-url-or-code>` validates `state` and completes the
token exchange for headless/SSH workflows. `vibest mcp auth set-token` and `vibest mcp auth logout` manage static
tokens and revocation. Custom headers are sent only to the exact `new URL(config.url).origin`, credentialed requests use
`redirect: "manual"`, RFC 8707 `resource` and SEP-2352 `issuer` are enforced, and `403` `insufficient_scope` challenges
surface `needs_auth` with the required scope.

## MCP6. Safe fingerprint metadata cache and TypeScript signatures

Tool metadata is cached by SHA-256 fingerprint of server identity and tool filters, rendering compact TypeScript
signatures via `renderTsShape`. Listings marked `cacheScope: "private"`, `ttlMs: 0`, or from local servers with unfixed
workspace-dependent `cwd` stay in memory only and are never written to disk. Stale-while-revalidate updates the cache on
connect, on `notifications/tools/list_changed`, and once automatically when `callTool` hits `-32602` or an unknown tool.

## MCP7. MCP-over-Skill compilation and scratchpad overflow guard

`vibest mcp sync-skills` compiles `<vibestHome>/skills/mcp-<server>/SKILL.md` (or `.agents/skills/mcp-<server>/SKILL.md`
when scoped to a project) for every enabled server with `exposure: "skill"`, containing YAML frontmatter, server
instructions, compact `toolName(tsSignature)` entries, and `vibest mcp describe` / `vibest mcp call` usage commands.
`vibest mcp call` guards output size (default 32 KiB): oversized results are written to
`$VIBEST_SCRATCHPAD_DIR/mcp-<server>-<tool>-<uuid>.txt` (falling back to `os.tmpdir()`) and return a bounded preview
with `truncated: true` and `outputFile`.

## MCP8. SEP-3415 MCP Events

Servers advertising `io.modelcontextprotocol/events` expose `events/list` (`vibest mcp events <server>`) and
`events/stream` routed by `_meta["io.modelcontextprotocol/subscriptionId"]`, with a 60-second heartbeat silence timeout,
`active.truncated` cursor gap detection, and pool stream pinning (`activeStreams`) while subscribed.
