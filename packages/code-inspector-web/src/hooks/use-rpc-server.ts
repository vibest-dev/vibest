import { useEffect, useMemo } from "react";

import type { InspectorRpcClientFunctions, InspectorRpcServerFunctions } from "../types";

import { inspectorStore } from "../store";

/**
 * RPC Server Hook - Use inside the iframe/client.
 *
 * Subscribes to inspector store updates and forwards them to the host via RPC.
 * Accepts RPC commands from the host to mutate the local inspector store.
 */
export function useInspectorRpcServer(rpc: () => InspectorRpcClientFunctions) {
  useEffect(() => {
    // Select the raw array so store.emit only fires when the list reference changes; strip DOM nodes inside the subscriber.
    const inspectedTargets = inspectorStore.select((context) => context.inspectedTargets);
    const inspectedState = inspectorStore.select((context) => context.state);

    const subscriptions = [
      inspectedTargets.subscribe((targets) => {
        rpc().inspectedTargetsChange({
          targets: targets.map(({ element: _element, ...rest }) => rest),
        });
      }),
      inspectedState.subscribe((state) => {
        rpc().inspectedStateChange({ state });
      }),
    ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  }, [rpc]);

  const handler = useMemo(
    () =>
      ({
        async inspectStart() {
          inspectorStore.trigger.START();
        },
        async inspectStop() {
          inspectorStore.trigger.STOP();
        },
        async inspectRemove({ id }) {
          inspectorStore.trigger.REMOVE_INSPECTED_TARGET({ id });
        },
        async inspectClear() {
          inspectorStore.trigger.CLEAR_INSPECTED_TARGETS();
        },
      }) satisfies InspectorRpcServerFunctions,
    [],
  );

  return handler;
}
