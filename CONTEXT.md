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
