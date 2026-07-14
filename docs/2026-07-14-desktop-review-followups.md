# Desktop app: adversarial review follow-ups

Findings from an adversarial review of PR #100 (web-as-Electron-UI). Each was
verified against source; attacks that didn't land are listed at the bottom so we
don't re-litigate them. Not fixed in PR #100 — tracked here for follow-up.

## High

### 1. The backend is unsupervised after startup

`apps/desktop/src/main/backend.ts` watches the child only during the 30 s startup
window. Once the ready line parses it calls `child.removeAllListeners("exit")` and
drops the error listener — nothing watches the process after that. If the server
crashes mid-session (SDK throws, OOM, killed), Electron still holds
`httpBaseUrl`/`token` and believes it's alive; every call fails with
`ECONNREFUSED`, with no restart and no dialog. The app is a zombie until quit.

opencode watches two ways: the MessagePort handshake _and_ a periodic HTTP health
poll. t3code has a whole `backend/` supervisor. **Fix:** keep an exit listener after
ready; on unexpected exit, either relaunch the backend or surface a dialog and quit.

## Medium

### 2. Orphaned server on a hard kill of Electron

The child is spawned without `detached`/process-group handling, and teardown is only
`app.on("before-quit") → child.kill()` (`index.ts`). `before-quit` does not fire on
SIGKILL or a crash of Electron, so the server reparents to init and keeps running on
its random port, invisible, accumulating across crashes. **Fix:** a kill-on-parent
guard (e.g. the child polls `process.ppid`, or a process-group kill).

### 3. Second-instance still spawns a backend

`index.ts` calls `app.quit()` when the single-instance lock isn't acquired but does
not `return`, so the `app.whenReady()` handler can still run `startBackend()` (and a
`loginShellPath()` shell exec) from an instance that's meant to be dying. **Fix:**
wrap all startup in the `else`, or `return` after `app.quit()`.

### 4. Claude-binary version skew, invisible in dev

`electron-builder.yml` excludes `@anthropic-ai/claude-agent-sdk-*`, so the packaged
app always falls through to the user's PATH `claude` (`executable.ts`), while dev
prefers the SDK's bundled, version-matched copy. The SDK is pinned to a wire
protocol; the user's independently-updated Claude Code is not — and the mismatch path
is never exercised in dev. When it breaks it's an opaque mid-session SDK error, not a
clean "unsupported version." **Fix:** consider a version probe at session start, or
at least a clearer error.

### 5. `loginShellPath` breaks on fish/nushell and slow rc — packaged only — ✅ FIXED (commit 4f669e7)

Fixed by reading the exported env via `printenv PATH` instead of interpolating
`"$PATH"`, plus a `launchctl getenv PATH` fallback on darwin. Original writeup
kept below for context.

`apps/desktop/src/main/shell-path.ts` runs `$SHELL -ilc 'printf … "$PATH" …'`.

- **fish**: `$PATH` is space-separated, so the fenced value comes back space-delimited — the resulting PATH is garbage and `claude` isn't found.
- **nushell**: `-ilc` isn't valid → shell errors → `undefined` → falls back to launchd's bare PATH → `claude` not found.
- **slow rc** (`-i` shell whose profile blocks > 5 s): hits the timeout → `undefined` → same bare-PATH failure.

Only runs when `app.isPackaged`, so none of it is reachable in `pnpm dev`. Combined
with #4, this is the most likely real-world bug: session-create throws "Claude Code
was not found" for users with a perfectly valid install. **Fix:** parse the shell's
PATH more defensively (split on both `:` and whitespace), add t3code's
`launchctl getenv PATH` fallback on darwin, and fall back to probing the known
install dirs even when the shell probe fails.

### 6. Ad-hoc `--deep` signature can't be notarized; publish URL is a placeholder

`scripts/ad-hoc-sign.cjs` uses `codesign --deep`, which Apple discourages, and an
ad-hoc signature can never be notarized — any downloaded DMG/zip is Gatekeeper-blocked.
`electron-builder.yml`'s `publish` points at `https://example.com/auto-updates`.
Fine for local builds; the distribution story is not real yet. **Fix (later):** a real
Developer ID + notarization, and a real update feed, before distributing.

## Low

- **Expired WS tickets are never swept** (`packages/vibest/src/node/auth.ts`): entries are removed only on `consume`; issued-but-abandoned tickets live forever. Auth-gated, so slow growth, not a DoS. Add a lazy purge on `issue`.
- **WS upgrade ignores the pathname** (`packages/vibest/src/node/server.ts`): a valid ticket upgrades a socket on any path, not just `/ws/rpc`. Needs a valid ticket→token, so not exploitable; just a looser contract.
- **`decodeURIComponent` can throw uncaught** (`apps/desktop/src/main/protocol.ts`): a path with a lone `%` throws `URIError`, rejecting the handle promise instead of a clean 404. Wrap and 404.

## Attacks that did NOT land (verified, don't re-litigate)

- **Token env-deletion is theater** — no. It runs synchronously before any agent child spawns, so agent-run shell tools don't inherit it. It doesn't stop a process that can already read the parent env, but such a process has our UID and can read memory / MITM loopback anyway; that's not the boundary.
- **Path traversal in `protocol.ts`** — guard holds. `path.resolve` + `path.relative` catches `..%2f`, double-encoding, absolute paths and `\` before the check.
- **CORS spoof / loopback brute-force** — CORS isn't the boundary, the 122-bit token is; a raw socket ignores CORS regardless and can't guess the token.
- **`tokensMatch` not constant-time** — it's length-check then full-width XOR accumulate; runtime is independent of match position. Leaks only length, which for a fixed UUID isn't secret.
- **`/api/health` info leak** — returns literal `"ok"`, nothing disclosed.
- **No CSP** — false; the renderer ships a `connect-src`-restricted CSP meta tag.
- **`VIBEST_CLAUDE_EXECUTABLE` injection** — setting an env var already requires local control; a footgun, not a remote vector.
- **Chunked stdout splits the ready line** — `readline.createInterface` reassembles across chunks.
