import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { HarnessAgentId, HarnessAgentInfo, HarnessAgentCatalog } from "@vibest/contract";

// The negotiation is a single connection-level exchange (see the root route's
// loader), so this resolves to one shared query the whole app reads. Switching
// the selected harness reads a different entry of the same held result — it
// never re-negotiates.
export function useHarnessNegotiation() {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery(orpcQueryUtils.harness.negotiate.queryOptions({ input: {} }));
}

/** Every harness the server hosts, unavailable ones included — the picker
 * shows them disabled with their reason rather than hiding them. */
export function useHarnessAgents(): ReadonlyArray<HarnessAgentInfo> {
  const { data } = useHarnessNegotiation();
  return data?.harnessAgents ?? [];
}

/** The negotiated info for one harness, or undefined until negotiation lands. */
export function useHarnessAgent(harnessAgentId: HarnessAgentId): HarnessAgentInfo | undefined {
  const { data } = useHarnessNegotiation();
  return data?.harnessAgents.find((harnessAgent) => harnessAgent.id === harnessAgentId);
}

/**
 * The runtime catalog for one harness in one directory — undefined until it
 * lands, which callers treat as "no models yet" rather than as a wait.
 *
 * Unlike the negotiation this is fetched lazily and costs a CLI spawn, so it is
 * held far longer than TanStack's defaults would: without a `staleTime` every
 * window focus would re-probe. The server de-duplicates concurrent asks and
 * holds its own short-lived answer, so a stale read here is cheap to correct
 * and an eager one is not.
 */
export function useHarnessCatalog(
  harnessAgentId: HarnessAgentId,
  cwd: string | undefined,
): HarnessAgentCatalog | undefined {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const { data } = useQuery({
    ...orpcQueryUtils.harness.catalog.queryOptions({
      input: { harnessAgentId, cwd: cwd ?? "" },
    }),
    enabled: cwd !== undefined,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return data;
}
