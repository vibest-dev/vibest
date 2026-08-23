import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionRef, SessionSummary } from "@vibest/contract";
import { useCallback } from "react";

import { sameSessionRef } from "@/lib/session-ref";

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

export const selectProjectSessionTitle = (
  sessions: ReadonlyArray<SessionSummary>,
  ref: SessionRef,
): string | null | undefined => {
  const session = sessions.find((candidate) => sameSessionRef(candidate, ref));
  return session === undefined ? undefined : (session.title ?? null);
};

/**
 * One session title from a project's held lists.
 *
 * The selector closes over the primitive SessionRef fields, so it stays
 * memoised: title events can patch the shared list while this consumer
 * re-renders only for its own title.
 * The archived list stays cold unless the active list has loaded without the
 * routed session; this preserves archived bookmarks without doubling the usual
 * session-page request.
 */
export function useProjectSessionTitle(ref: SessionRef | undefined): string | undefined {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const projectId = ref?.projectId;
  const harnessAgentId = ref?.harnessAgentId;
  const sessionId = ref?.sessionId;
  const enabled =
    projectId !== undefined && harnessAgentId !== undefined && sessionId !== undefined;
  const select = useCallback(
    (sessions: ReadonlyArray<SessionSummary>) =>
      projectId === undefined || harnessAgentId === undefined || sessionId === undefined
        ? undefined
        : selectProjectSessionTitle(sessions, { projectId, harnessAgentId, sessionId }),
    [harnessAgentId, projectId, sessionId],
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

  if (active.data !== undefined) return active.data ?? undefined;
  return archived.data ?? undefined;
}
