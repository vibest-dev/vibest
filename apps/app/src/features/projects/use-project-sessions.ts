import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";

const NO_SESSIONS: ReadonlyArray<SessionSummary> = [];

// Newest-first: a session is opened right after it is created. Module scope
// keeps `select` referentially stable across renders.
const selectNewestFirst = (
  sessions: ReadonlyArray<SessionSummary>,
): ReadonlyArray<SessionSummary> =>
  Array.from(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * The sessions under one project, newest-first.
 *
 * Held briefly, unlike `project.list`: this key has writers we don't drive —
 * the draft route seeds an optimistic row, `SessionEventsSync` patches titles
 * in from `session.updated`.
 */
export function useProjectSessions(projectId: string): ReadonlyArray<SessionSummary> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const { data } = useQuery({
    ...orpcQueryUtils.session.list.queryOptions({ input: { projectId } }),
    staleTime: 30_000,
    select: selectNewestFirst,
  });
  return data ?? NO_SESSIONS;
}
