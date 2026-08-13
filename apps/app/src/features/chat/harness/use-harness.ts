import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type {
  HarnessAgentId,
  HarnessAgentInfo,
  HarnessGetDefaultModelOutput,
  HarnessListModelsOutput,
  HarnessListOutput,
  SessionRef,
} from "@vibest/contract";
import { useCallback } from "react";

// `harness.list` is a single connection-level exchange (see the root route's
// loader), so every hook below reads one shared query — switching the selected
// harness reads a different slice of the same held result, never re-fetches.
// Each hook narrows inside `select` so it only re-renders when its own slice
// changes, not on every list update.
function useHarnessListQuery<TData>(select: (output: HarnessListOutput) => TData) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({ ...orpcQueryUtils.harness.list.queryOptions({ input: {} }), select });
}

const NO_AGENTS: ReadonlyArray<HarnessAgentInfo> = [];
const selectHarnessAgents = (output: HarnessListOutput) => output.harnessAgents;

/** Every harness the server hosts, unavailable ones included — the picker
 * shows them disabled with their reason rather than hiding them. */
export function useHarnessAgents(): ReadonlyArray<HarnessAgentInfo> {
  const { data } = useHarnessListQuery(selectHarnessAgents);
  return data ?? NO_AGENTS;
}

/** The declared info for one harness, or undefined until the list lands. */
export function useHarnessAgent(harnessAgentId: HarnessAgentId): HarnessAgentInfo | undefined {
  const { data } = useHarnessListQuery(
    // The select closes over `harnessAgentId`, so it must be memoised — an
    // inline closure is a new function every render, which makes TanStack
    // Query re-run it and lose referential stability.
    useCallback(
      (output: HarnessListOutput) =>
        output.harnessAgents.find((harnessAgent) => harnessAgent.id === harnessAgentId),
      [harnessAgentId],
    ),
  );
  return data;
}

/**
 * The model providers for one harness. A managed session ref lets the server
 * use that session's existing runtime; without one, it performs the cached
 * directory query. Failures remain distinct from an empty provider list.
 *
 * While `cwd` is unknown the input is `skipToken`, not a fabricated value:
 * unlike `enabled: false`, a skipped query cannot be forced to run by
 * `refetch()` against a made-up directory.
 */
export function useHarnessDefaultModel(
  harnessAgentId: HarnessAgentId,
  cwd: string | undefined,
): UseQueryResult<HarnessGetDefaultModelOutput> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.harness.getDefaultModel.queryOptions({
      input: cwd === undefined ? skipToken : { harnessAgentId, cwd },
    }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useHarnessModels(
  harnessAgentId: HarnessAgentId,
  cwd: string | undefined,
  ref?: SessionRef,
  runtimeActive = false,
): UseQueryResult<HarnessListModelsOutput> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const options = orpcQueryUtils.harness.listModels.queryOptions({
    input:
      cwd === undefined
        ? skipToken
        : { harnessAgentId, cwd, ...(ref ? { ref, runtimeActive } : {}) },
  });
  return useQuery({
    ...options,
    // Runtime phase participates in the generated query key. Zero GC prevents
    // the old directory answer from resurfacing when the first turn settles.
    gcTime: ref ? 0 : undefined,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
