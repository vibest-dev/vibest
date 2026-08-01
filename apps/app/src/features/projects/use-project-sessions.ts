import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";

const NO_SESSIONS: ReadonlyArray<SessionSummary> = [];

// Newest-first: a session is opened right after it is created, so the one the
// user is about to want is at the top. Module scope keeps `select`
// referentially stable across renders.
const selectNewestFirst = (
  sessions: ReadonlyArray<SessionSummary>,
): ReadonlyArray<SessionSummary> =>
  Array.from(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * The sessions under one project, newest-first, exactly as the server has them.
 *
 * This is the whole seam: how the list is fetched, how long it is held, and
 * what order it comes back in. What a session *looks* like in a list — its
 * label when untitled, whether it reads as current, what a click does — is the
 * renderer's business and deliberately not answered here.
 *
 * Held briefly rather than indefinitely, unlike `project.list`: this key has
 * writers we don't drive. The draft route seeds an optimistic row on create,
 * and `SessionEventsSync` patches titles in from `session.updated` — the
 * harness fills a title in after the fact (claude summarizes a session once it
 * has something to summarize), so a just-created session shows its optimistic
 * title until the server's own lands.
 *
 * Returns the summaries alone, not the query: the list is additive and its
 * failure is not actionable where it renders — an empty project and an
 * unreachable server both correctly draw nothing under the project's name. A
 * caller that needs to tell those apart wants its own query, not a wider
 * return here.
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
