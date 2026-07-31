# vibest

Glossary of project-specific terms. vibest integrates AI coding agents into the browser; this file names the concepts that recur across the codebase.

## Session Domain

**Project**:
A working directory the user has registered with the server, identified by a server-generated UUID. The single source of the projectId → directory mapping; the directory field is `path`. Sessions always resolve their working directory through a Project, never from a caller-supplied path.
_Avoid_: workspace, repo, cwd (for the Project field)

**SessionRef**:
The composite identity `{ projectId, harnessAgentId, sessionId }` that every session operation addresses. `sessionId` is a server-generated opaque UUID, unique within a project.
_Avoid_: bare sessionId as a wire identity

**Harness session id**:
The agent-native session identity (Claude session UUID, Codex thread ID) held in the session's metadata. Internal plumbing for resume/history — never exposed as wire identity.
_Avoid_: native id

**Session metadata**:
The server-owned recovery record for a session: which Project, which harness agent, which harness session id. Distinct from conversation history, which stays in the agent's native storage.

**Workspace path**:
The validated absolute directory handed to a harness agent when opening or resuming a session; always derived from `Project.path`, never accepted directly from session API callers.
_Avoid_: cwd (in session APIs)

## Server Session Services

The session domain (`packages/server/src/harness/`) has exactly five public roles. One-liner: Registry knows who exists, Adapter knows how to get in, Manager knows who is alive and what they're doing, Session knows what a live session can do, Service is the outward face. The `HarnessAgent` prefix is a namespace — read names right-to-left: the last word says what it is, the prefix only says which domain it belongs to.

**HarnessAgentSessionService** (`harness/session-service.ts`):
The outward session service the RPC router calls, addressed by SessionRef: generates server sessionIds, persists metadata (private repository), translates SessionRef → harness session id, validates wire vocabulary (permission modes, prompt parts), publishes collection events. Holds no live state. Receives the workspace path from the router; never resolves a projectId itself.
_Avoid_: SessionService (its dissolved predecessor in `session/service.ts`)

**HarnessAgentSessionManager** (`harness/session-manager.ts`):
The sole owner of live session state: the active/inFlight/closing instance machine _and_ the per-session projection (via its private runtime module). Sole caller of `adapter.open`/`adapter.resume` — adapters may assume single-flight per session id. A built instance always has a draining projection, by construction. A crash closes the instance but keeps the projection queryable (phase "crashed") until an explicit `close`.

**HarnessAgentAdapter / HarnessAgentSession** (`harness/adapter.ts`):
The per-harness door (descriptor, availability, probes, open/resume factory, cold reads) and the live-session wrapper it produces (prompt/events/config/close). The per-agent `XxxAgent` façades under `harness/<agent>/` are private protocol plumbing below the adapter, not shared abstractions.

**Private modules** (no Context tags, never wired directly):
`harness/session-runtime.ts` — the manager's projection machine (seq stamping, fold, snapshot/status). `harness/session-repository.ts` — the service's metadata store over `storage/sessions/`.
_Avoid_: SessionRuntimeService, SessionManager (pre-dissolution names for the runtime module)

## UI Components

**Base component**:
A primitive in `packages/ui/src/components/` (button, dialog, select, …). Most are vendored from the [Coss registry](#coss-registry) and built on Base UI; a couple not carried by coss (`carousel` on embla, `splitter` on Ark UI) are kept locally. Refreshed wholesale from the registry rather than hand-authored.
_Avoid_: shadcn component, primitive

**Composite component**:
A higher-level component assembled from base components, living in `packages/ui/src/ai-elements/` and `packages/ui/src/claude-code/`. Hand-maintained; never sourced from a registry.
_Avoid_: widget, element

**Coss registry**:
The upstream shadcn-style component registry at `coss.com/ui` (the `@coss` namespace in `components.json`). It is the source of truth for base components. It is a rolling "latest" — items carry no version or date, so "the latest version" means whatever the registry serves now.
_Avoid_: coss/ui (repo shorthand)
