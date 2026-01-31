import { useEffect, useEffectEvent, useMemo } from "react";

import type { InspectorRpcClientFunctions, InspectorRpcServerFunctions } from "../types";

import { inspectorStoreSync } from "../store";

/**
 * RPC Client Hook - Use inside the host/parent app.
 *
 * Listens to local optimistic store events and forwards them to the iframe via RPC.
 * Applies RPC updates from the iframe by mutating the sync store.
 */
export function useInspectorRpcClient(rpc: () => InspectorRpcServerFunctions) {
  useEffect(() => {
    const subscriptions = [
      inspectorStoreSync.on("STARTED", () => {
        rpc().inspectStart();
      }),
      inspectorStoreSync.on("STOPPED", () => {
        rpc().inspectStop();
      }),
      inspectorStoreSync.on("TARGET_REMOVED", ({ id }) => {
        rpc().inspectRemove({ id });
      }),
      inspectorStoreSync.on("TARGETS_CLEARED", () => {
        rpc().inspectClear();
      }),
    ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  }, [rpc]);

  const inspectedTargetsChange = useEffectEvent<
    InspectorRpcClientFunctions["inspectedTargetsChange"]
  >(({ targets }) => {
    inspectorStoreSync.trigger.SET_INSPECTED_TARGETS({ targets });
  });
  const inspectedStateChange = useEffectEvent<InspectorRpcClientFunctions["inspectedStateChange"]>(
    ({ state }) => {
      inspectorStoreSync.trigger.SET_INSPECTED_STATE({ state });
    },
  );

  return useMemo(
    () => ({
      inspectedTargetsChange,
      inspectedStateChange,
    }),
    [],
  );
}
