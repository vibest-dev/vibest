import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";
import { useCallback } from "react";

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
 * the draft route seeds an optimistic row, `useSessionListSync` patches titles
 * in from `session.updated`.
 */
export function useProjectSessions(
  projectId: string,
  { archived = false, enabled = true }: { archived?: boolean; enabled?: boolean } = {},
) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.session.list.queryOptions({ input: { projectId, archived } }),
    enabled,
    staleTime: 30_000,
    select: selectNewestFirst,
  });
}

export const selectProjectSession = (
  sessions: ReadonlyArray<SessionSummary>,
  sessionId: string,
): SessionSummary | undefined => sessions.find((session) => session.sessionId === sessionId);

/**
 * One session from a project's held lists.
 *
 * The selector closes over `sessionId`, so it stays memoised: title events can
 * patch the shared list while this consumer re-renders only for its own row.
 * The archived list stays cold unless the active list has loaded without the
 * routed session; this preserves archived bookmarks without doubling the usual
 * session-page request.
 */
export function useProjectSession(
  projectId: string | undefined,
  sessionId: string | undefined,
): SessionSummary | undefined {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const enabled = projectId !== undefined && sessionId !== undefined;
  const select = useCallback(
    (sessions: ReadonlyArray<SessionSummary>) =>
      sessionId === undefined ? undefined : selectProjectSession(sessions, sessionId),
    [sessionId],
  );
  const active = useQuery({
    ...orpcQueryUtils.session.list.queryOptions({
      input: { projectId: projectId ?? "", archived: false },
    }),
    enabled,
    staleTime: 30_000,
    select,
  });
  const archived = useQuery({
    ...orpcQueryUtils.session.list.queryOptions({
      input: { projectId: projectId ?? "", archived: true },
    }),
    enabled: enabled && active.isSuccess && active.data === undefined,
    staleTime: 30_000,
    select,
  });

  return active.data ?? archived.data;
}
