# Frontend state and routing

Derive, don't sync: no `useEffect` mirroring state between sources — compute it
at render with `useMemo`. Server state stays in TanStack Query, client state in
Zustand, and selections store an id, not the object.

`eslint-plugin-react-you-might-not-need-an-effect` enforces this, loaded as an
oxlint JS plugin (`jsPlugins` in `.oxlintrc.json`) with all nine rules at
`error`. `packages/ui/src/{components,hooks,ai-elements}/**` is exempt: those
files are vendored or ported from upstream (`docs/adr/0001`), so a fix there is
discarded on the next refresh and belongs upstream instead. A host-pushed value
is a `useSyncExternalStore` source, not an effect — give the feed a
`getSnapshot` (`ServerStatusFeed` is the shape to copy) rather than mirroring it
into `useState`. An effect the rules genuinely misread — an editor's lifetime,
say — gets an `eslint-disable-next-line` on the line the rule anchors to (the
`setState` call, not always the `useEffect`) plus a sentence saying why.

## Where a file goes

`apps/app/src/features/<feature>/` holds everything one feature needs —
components, hooks, and its own non-React runtime alike. `features/chat/` is the
shape to copy: `components/` for its UI, `runtime/` for the Chat/ChatManager
machinery, `harness/` for the pure config resolvers, `claude-code/` + `codex/`
for per-agent tool rendering.

- **Features never import each other.** `@/features/a/…` inside `features/b/`
  is the one import this app forbids; `grep -rn 'from "@/features/' features`
  should never show a name crossing to a different one. When two features have
  to meet, the need travels up as a prop: the session route resolves `cwd`
  through `useProject` and hands it to `Chat`, rather than chat reaching into
  projects.
- **Only composition roots may combine features**: `routes/`,
  `app-interface.tsx`, and the app shell in `components/layout/`. Those four
  files are the whole allow-list today.
- **`components/` is for what no single feature owns** — the shell
  (`layout/`) and generic pieces (`loader.tsx`). Base and composite UI belongs
  in `@vibest/ui`, not here.
- **The root export (`index.ts`) is the desktop seam.** `AppInterface`,
  `PlatformProvider`, `ServerStatusOverlay` and the platform types live at
  `src/` top level because `apps/desktop` mounts them; they are not features and
  must not be moved into one.
- There is no `core/`. It existed without a written rule, accumulated both pure
  runtime and `.tsx` components, and was dissolved into the above — don't
  reintroduce it as a home for "shared" code. A hook used by exactly one
  component sits next to that component.

- **Query keys come from `orpcQueryUtils.<router>.<proc>`.** Write cache with
  `queryOptions({input}).queryKey`; `.key()` omits the `type:"query"` segment, so
  using it for `setQueryData` silently writes a cache the UI never reads. `.key()`
  is for `invalidateQueries` only.
- **Narrow a query with `select`, not in the component.** When a hook needs one
  field out of a list query, derive it inside `useQuery`'s `select` — narrowing
  after the fact (`data?.find(...)`) subscribes the component to the whole list.
  A `select` that closes over a prop must be memoised (`select: useCallback(fn,
[dep])`) or it re-runs every render and loses referential stability; say so in
  a comment so nobody "simplifies" the `useCallback` away.
- Zustand here is not a global store: each `Chat` instance creates its own vanilla
  store as the AI SDK `ChatState`. `ChatManager` caches Chat instances by
  sessionId so transcripts survive navigation, and is constructed at App mount
  (module scope has no host connection yet).
- `SessionEventsSync` is the only consumer of the global event firehose; session
  events (chunks, requests) belong to the per-session chat transport.
- The live stream has no replay: subscribe before `session.prompt`, and recover
  from a drop with `getSnapshot` + `seq > cursor`, not by replaying.
  `session.turn.started` is never re-sent — a turn present in the snapshot counts
  as started.
- `createFileRoute("/draft")` needs a literal path — a variable breaks the router
  plugin's auto code splitting. `routeTree.gen.ts` regenerates only when the Vite
  router plugin runs, not on typecheck: after adding or renaming routes, load the
  app root once before typechecking.
- The root `Outlet` must not be swapped on router `isLoading` — a same-route
  search change flips it, and remounting discards what the user has typed.
