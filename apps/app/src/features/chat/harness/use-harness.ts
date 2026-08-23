import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type {
  HarnessAgentId,
  HarnessAgentInfo,
  HarnessListOutput,
  HarnessProbeOutput,
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
 * The probed model providers for one harness in one directory. Returns the
 * whole query, because its failure is meaningful: a failed probe must stay
 * distinguishable from "this harness has no models" (empty providers), so the
 * UI can render a retryable degraded state instead of silently hiding the
 * picker.
 *
 * While `cwd` is unknown the input is `skipToken`, not a fabricated value:
 * unlike `enabled: false`, a skipped query cannot be forced to run by
 * `refetch()`, so the retry affordance can never fire a probe against a
 * made-up directory.
 *
 * Unlike the list this is fetched lazily and costs a CLI spawn, so it is held
 * far longer than TanStack's defaults would: without a `staleTime` every
 * window focus would re-probe. The server de-duplicates concurrent asks and
 * holds its own short-lived answer, so a stale read here is cheap to correct
 * and an eager one is not.
 */
export function useHarnessProbe(
  harnessAgentId: HarnessAgentId,
  cwd: string | undefined,
): UseQueryResult<HarnessProbeOutput> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.harness.probe.queryOptions({
      input: cwd === undefined ? skipToken : { harnessAgentId, cwd },
    }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
