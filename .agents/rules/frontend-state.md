# Frontend state and routing

Derive, don't sync: no `useEffect` mirroring state between sources — compute it
at render with `useMemo`. Server state stays in TanStack Query, client state in
Zustand, and selections store an id, not the object.

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
