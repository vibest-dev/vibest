import { useRouteContext } from "@tanstack/react-router";
import { useEffect } from "react";

import { isAbortError, sleep } from "@/lib/utils";

import { applySessionListEvent } from "./session-list-cache";

const RESUBSCRIBE_DELAY_MS = 1000;

// The one always-on consumer of the global (firehose) subscription, called
// once from the root layout. It keeps every open `session.list` cache
// converged — across tabs and the desktop app, not just the tab that drove
// the change — by folding each event through `applySessionListEvent`; chunks
// and requests still belong to the per-session Chat transport.
export function useSessionListSync(): void {
  const { orpcClient, orpcQueryUtils, queryClient } = useRouteContext({ from: "__root__" });
  // The cleanup below does own every allocation, but the rule only recognizes
  // teardown it can name (`unsubscribe()`, `clearTimeout`, `socket.close`) and
  // can't follow an AbortController: aborting the signal cancels the in-flight
  // `subscribe`, terminates the `for await`, and settles a pending `sleep`.
  // react-doctor-disable-next-line effect-needs-cleanup
  useEffect(() => {
    const abort = new AbortController();

    // The exact key the sidebar's `session.list` query reads — the `queryOptions`
    // key carries `type: "query"`, which the bare `.key({ input })` omits, so
    // setQueryData must use this or it writes a phantom entry nothing renders.
    const listKeyFor = (projectId: string) =>
      orpcQueryUtils.session.list.queryOptions({ input: { projectId } }).queryKey;

    const run = async () => {
      while (!abort.signal.aborted) {
        try {
          const stream = await orpcClient.session.subscribe(
            { scope: { kind: "global" } },
            { signal: abort.signal },
          );
          for await (const item of stream) {
            if (item.type !== "event") continue;
            applySessionListEvent(queryClient, listKeyFor, item.event);
          }
        } catch (error) {
          if (abort.signal.aborted || isAbortError(error)) return;
        }
        if (abort.signal.aborted) return;
        // The stream ended (server teardown / dropped connection): phase
        // transitions may have been missed, so the patched statuses can be
        // stale — refetch every list rather than trust them.
        void queryClient.invalidateQueries({ queryKey: orpcQueryUtils.session.list.key() });
        // Back off, then re-subscribe. Resolves early on abort so unmount
        // doesn't wait out the delay.
        await sleep(RESUBSCRIBE_DELAY_MS, abort.signal);
      }
    };

    void run();
    return () => abort.abort();
  }, [orpcClient, queryClient, orpcQueryUtils]);
}
