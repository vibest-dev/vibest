import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { HarnessAgentId, HarnessAgentInfo } from "@vibest/contract";

// The negotiation is a single connection-level exchange (see the root route's
// loader), so this resolves to one shared query the whole app reads. Switching
// the selected harness reads a different entry of the same held result — it
// never re-negotiates.
export function useHarnessNegotiation() {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery(orpcQueryUtils.harness.negotiate.queryOptions({ input: {} }));
}

/** The negotiated info for one harness, or undefined until negotiation lands. */
export function useHarnessAgent(harnessAgentId: HarnessAgentId): HarnessAgentInfo | undefined {
  const { data } = useHarnessNegotiation();
  return data?.harnessAgents.find((harnessAgent) => harnessAgent.id === harnessAgentId);
}
