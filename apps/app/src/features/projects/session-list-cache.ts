import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ListSessionsOutput, ServerEvent } from "@vibest/contract";
import { isSessionScopedEvent } from "@vibest/contract";

type SessionRow = ListSessionsOutput[number];

export type ListKeyFor = (projectId: string) => QueryKey;

// One in-place row edit. Returns whether the row existed; an `update` that
// returns the same row leaves the previous array untouched, so query
// subscribers don't re-render on a no-op.
const patchRow = (
  queryClient: QueryClient,
  listKey: QueryKey,
  sessionId: string,
  update: (row: SessionRow) => SessionRow,
): boolean => {
  let found = false;
  queryClient.setQueryData<ListSessionsOutput>(listKey, (prev) => {
    if (!prev) return prev;
    const index = prev.findIndex((s) => s.sessionId === sessionId);
    const row = index === -1 ? undefined : prev[index];
    if (!row) return prev;
    found = true;
    const next = update(row);
    if (next === row) return prev;
    const copy = prev.slice();
    copy[index] = next;
    return copy;
  });
  return found;
};

/**
 * Fold one firehose event into the `session.list` caches. Pure with respect to
 * React — the hook owns the subscription, this owns what an event means.
 *
 * Session-scoped events contribute only their server-stamped `phase` (the
 * runtime stamps its post-event phase, so this copies rather than re-derives);
 * chunk events are skipped for traffic — their phase never differs from the
 * lifecycle event that opened the turn. A phase or title for a row we don't
 * hold is dropped or resolved by one list refetch — the next load carries it.
 */
export const applySessionListEvent = (
  queryClient: QueryClient,
  listKeyFor: ListKeyFor,
  event: ServerEvent,
): void => {
  const listKey = listKeyFor(event.ref.projectId);
  if (isSessionScopedEvent(event)) {
    const phase = event.phase;
    if (phase === undefined || event.type === "session.message.chunk") return;
    patchRow(queryClient, listKey, event.ref.sessionId, (row) =>
      row.status?.phase === phase ? row : { ...row, status: { phase } },
    );
    return;
  }
  switch (event.type) {
    case "session.updated": {
      // Merge the new title into the existing row, preserving an optimistic
      // one's live status/createdAt. A row we don't hold yet (another client
      // created this session) → pull the authoritative list once; the read is
      // a cheap pure-storage query.
      const found = patchRow(queryClient, listKey, event.ref.sessionId, (row) =>
        event.title !== undefined ? { ...row, title: event.title } : row,
      );
      if (!found) void queryClient.invalidateQueries({ queryKey: listKey });
      break;
    }
    case "session.renamed":
      patchRow(queryClient, listKey, event.ref.sessionId, (row) => ({
        ...row,
        title: event.name,
      }));
      break;
    case "session.deleted":
      queryClient.setQueryData<ListSessionsOutput>(listKey, (prev) =>
        prev?.filter((s) => s.sessionId !== event.ref.sessionId),
      );
      break;
    case "session.created":
      // The creating tab already seeded this row optimistically; a title-less
      // row elsewhere has nothing to show yet. Other clients pick the session
      // up on its first prompt's `session.updated`, or their next list load.
      break;
  }
};
