# Session display data: our storage is the floor, the harness is the overlay

Session list/display fields (title, updatedAt, cwd, createdAt) are owned by **our
persisted session record** as a durable _floor_, and refreshed from the harness's
own session index (`getSessionInfo` / codex `thread/read`) as an authoritative
_overlay_ that is reconciled **into** storage — never read live at list time.

This reverses the earlier seam where `title` / `updatedAt` / `historyAvailable`
were sourced from the harness's `getSessionInfo` at every `session.list` call
(`packages/server/src/session/service.ts` `list`, which fans out one
`port.getSessionInfo` per session under `{ concurrency: 8 }`, and
`packages/server/src/harness/adapter.ts:72` `HarnessSessionInfo = { title?, updatedAt? }`).

## Context

Three backends expose wildly different session metadata:

- **claude-code** — `getSessionInfo(id, { dir })` returns a rich `SDKSessionInfo`
  (`sdk.d.ts:4199`): `summary`, `customTitle`, `firstPrompt`, `lastModified`,
  `createdAt`, `cwd`, `gitBranch`, `tag`, `fileSize`. It also offers
  `getSessionMessages(id, { dir })` (`sdk.d.ts:727`) for the transcript and
  `SDKSessionStateChangedMessage` (`idle`/`running`/`requires_action`) for live
  phase. Our claude adapter (`harness/claude-code/adapter.ts:441`) collapses all
  of this to `{ title: customTitle ?? summary, updatedAt: lastModified }`.
- **codex** — `thread/read` returns an even fuller `Thread`
  (`packages/harness/src/codex/protocol/v2/Thread.ts`): `name`, `preview`, `cwd`,
  `gitInfo`, `createdAt`, `updatedAt`, `recencyAt`, `status`, `turns`,
  `forkedFromId`, `parentThreadId`, `agentRole`, … Our codex adapter
  (`harness/codex/adapter.ts:287`) keeps only `{ title: name ?? preview, updatedAt }`.
- **pi** — no session index at all: `getSessionInfo` returns `{ _tag: "unsupported" }`
  (`harness/pi/adapter.ts:241`).

Two forces pull in opposite directions:

1. **We must own a floor.** pi has no backend index, so any field shown uniformly
   across claude/codex/pi cannot come _only_ from the harness — that path is empty
   for pi. `cwd` in particular is _our input_ to `create`, and is required to
   `resume` a claude session _before_ any `getSessionInfo` call is even possible
   (the SDK needs `cwd` to locate the session file). A brand-new session's title
   is just the first prompt, which the client already holds — this is what the
   optimistic-write in `apps/app/src/routes/draft.tsx` already exploits.
2. **The harness sees things we can't.** A session driven _outside_ vibest
   (`claude --resume <id>` in a terminal, another tool on the same session)
   advances its transcript, refines its auto-summary, gets `/rename`d, changes git
   branch — none of which vibest observes. An _imported_ pre-existing session has
   **no** floor at all; the harness index is its only source. And recency
   (`lastModified` / `recencyAt`) is tracked by the backend for free.

Neither "we own everything" nor "harness is the sole source" is correct. The
answer is a floor + overlay reconciled into one persisted record.

## Decision

**Per-field ownership**

| Field                  | Floor (ours)                                  | Overlay (harness)                                               | Winner                              |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `cwd`                  | written at `create`, required before `resume` | cross-check only                                                | **ours** (the one true exception)   |
| `title`                | first prompt (instant, offline, pi)           | auto-summary / `customTitle` / external rename                  | **harness when present**            |
| `createdAt`            | stamped at `create`                           | only source for imported sessions                               | ours for ours; harness for imported |
| `updatedAt` / recency  | fallback                                      | `lastModified` / `recencyAt` — cheaper & catches external drift | **harness**                         |
| whole imported session | none                                          | only source                                                     | **harness**                         |
| live `status`          | —                                             | via the event stream, **not** `getSessionInfo`                  | runtime                             |

**Reconcile mechanism (server-side, persisted)**

1. **Triggers:** reconcile on **turn end** (authoritative signal:
   `SDKSessionStateChangedMessage` `idle` for claude, turn-completed for codex) and
   on **session open / resume** (turn-end alone never fires for sessions mutated
   outside vibest; open-time reconcile closes that gap and is also how an imported
   session first gets a record).
2. **`updatedAt` is stamped locally** at turn end (we know a turn just ended — no
   `getSessionInfo` needed). `getSessionInfo` is called only for the
   agent-derived fields (`title` / `gitBranch`) and only while they may still
   change (title not yet stable, or an open-time refresh).
3. **Write only on real change.** Compare against the stored record; persist to
   `storage/sessions/<projectId>/<sessionId>.json` and publish `session.updated`
   on the bus (alongside the existing `session.renamed` / `session.deleted`,
   `session/service.ts`) **only** when a field actually changed — otherwise every
   turn becomes an event storm and the sidebar re-sorts on every turn.
4. **`session.list` becomes a pure storage read.** No per-session
   `getSessionInfo` fan-out; the `{ concurrency: 8 }` bound and the entire
   `cwd`-narrowing lookup race in `harness/claude-code/adapter.ts:441` are deleted.
5. **Client** keeps only the optimistic `setQueryData` on create (instant title);
   the server's `session.updated` event drives reconciliation for _all_ clients.
   The client-side turn-end store subscription added in
   `apps/app/src/routes/draft.tsx` is removed — the server event supersedes it
   (multi-client, persisted, survives reload).

## Implementation status

Landed (server-only, no contract or client change, storage schema kept at
`version: 1` with no migration — legacy records simply lack the new optional
fields and fall back):

- The persisted `Session` record (`packages/server/src/types/index.ts`) carries
  the floor + overlay fields: `cwd`, `title`, `updatedAt`, `historyAvailable`.
- `create` stamps `cwd` (the project path).
- `list` reads display fields from the record, reconciling against the harness
  index (`reconcileDisplay`) when the overlay may be stale: a record never
  reconciled (no stored `title`), **or a live session** (`status !== null`). The
  live condition matters because a title is not immutable — claude refines the
  first prompt into an auto-summary as turns accumulate, and recency advances —
  so a heal-once-then-freeze would pin the title to the first prompt forever.
  `reconcileDisplay` writes only when `getSessionInfo` returns something new, so
  a dormant-but-open session reads without writing, and idle/unopened/titled
  sessions (the bulk of a long sidebar) are a pure storage read with no backend
  lookup. Because the client re-lists on turn end, a refined title lands in that
  same list. A `missing` reconcile persists `historyAvailable: false`;
  `unsupported` (pi) leaves the floor. The heal-write is best-effort (a failed
  write never fails the list).

Deferred (the "push" half — a follow-up, because it touches the contract event
union and the client):

- A `session.updated` bus event so _other_ clients (a second tab, the desktop)
  converge without their own turn-end trigger. The single active client already
  sees refined titles via the live-reconcile-on-list above driven by its own
  turn-end `session.list` invalidation, so this is a multi-client optimization,
  not a correctness gap.
- Removing the client-side turn-end store subscription in `draft.tsx` (only
  worthwhile once the server publishes `session.updated`).
- Surfacing `gitBranch` (needs `HarnessSessionInfo` + the claude/codex adapters
  widened first).

## Consequences

- **list is cheap and offline-safe.** After the one-time heal, a pure read of our
  own storage; no backend round-trip, no fan-out limit, no dependency on the
  backend being reachable.
- **The `cwd`-narrowing bug class disappears.** `getSessionInfo({ dir })` is no
  longer on the hot path; the fallback-on-miss dance is gone.
- **Multi-client consistency.** A title refined in one tab reaches every tab and
  the desktop via `session.updated`, not just the tab that created the session.
- **pi is a first-class citizen.** It rides the floor; no overlay, no
  `session.updated`, no missing-title second-class rendering — which is exactly
  why the floor must exist.
- **External drift is bounded, not perfect.** A session driven outside vibest is
  reconciled the next time vibest opens/resumes it or runs a turn on it — not
  live. Acceptable; live external mirroring is a non-goal.
- **We give up** the agent's auto-summary refinement and terminal-side `/rename`
  _between_ reconcile points. Both peer tools (t3code, paseo) give up the same or
  more — t3code self-generates titles via a separate `claude -p --json-schema`
  call and never reads `getSessionInfo`; paseo derives the title from the first
  prompt line and uses `getSessionInfo` only as a test oracle.
- **Storage is now a cache.** It can go stale relative to the backend; the
  reconcile triggers are the cache-invalidation policy. `getSessionInfo` keeps a
  narrow, real job (agent-derived title + gitBranch overlay), demoted from
  sole-source-at-list-time.
- **A path to real history opens.** With `getSessionMessages` / codex `turns`
  available, the currently-`UNSUPPORTED` `session.getMessages` has a concrete
  implementation route (on demand, not at list time) if we choose to build it.

## Migration steps

1. Widen the persisted session record (`session-io` / the storage schema) to carry
   `title`, `updatedAt`, `createdAt`, `cwd`, and optionally `gitBranch`. `cwd` is
   already written at create; add the display fields.
2. Add a server-side reconcile step: on turn-end (`idle` / turn-completed) and on
   open/resume, call `port.getSessionInfo` for agent-derived fields, stamp
   `updatedAt` locally, diff against storage, and on change persist + publish
   `session.updated`.
3. Extend `HarnessSessionInfo` (`harness/adapter.ts:72`) to surface the fields the
   overlay actually carries (`title?`, `updatedAt?`, `createdAt?`, `cwd?`,
   `gitBranch?`); each adapter fills what it has (pi stays `unsupported`).
4. Rewrite `session/service.ts` `list` to read purely from storage — drop the
   per-session `getSessionInfo` fan-out and the `{ concurrency: 8 }` bound.
5. Simplify `harness/claude-code/adapter.ts:441`: `getSessionInfo` no longer needs
   the unnarrowed fallback-on-miss, since it is called with a known `cwd` at
   reconcile time, not blindly at list time.
6. Wire the client to `session.updated` (invalidate `session.list`, now a cheap
   storage read, or patch the cache from the event payload) and delete the
   turn-end store subscription in `apps/app/src/routes/draft.tsx`, keeping only the
   optimistic `setQueryData`.
7. Imported/discovered sessions: on first open, a reconcile with no prior floor
   creates the storage record straight from the overlay.
