import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createVibestClient, type VibestClient } from "@vibest/client";
import { toast } from "sonner";

import type { Platform } from "@/platform";

export type AppClients = {
  queryClient: QueryClient;
  rpcClient: VibestClient;
  orpc: ReturnType<typeof createTanstackQueryUtils<VibestClient>>;
};

function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        toast.error(`Error: ${error.message}`, {
          action: {
            label: "retry",
            onClick: () => {
              queryClient.invalidateQueries();
            },
          },
        });
      },
    }),
  });
  return queryClient;
}

/**
 * Build the RPC client for a host. Browser mode is same-origin, so the
 * origin-derived `/ws/rpc` default is correct and no credential is needed. The
 * desktop renderer's origin is `vibest://app` while its backend is on loopback,
 * so it connects with a ticket minted over the authenticated HTTP endpoint.
 */
export function createAppClients(platform: Platform): AppClients {
  const queryClient = createQueryClient();

  if (platform.host === "web") {
    const rpcClient = createVibestClient();
    return {
      queryClient,
      rpcClient,
      orpc: createTanstackQueryUtils(rpcClient),
    };
  }

  const { httpBaseUrl, wsBaseUrl, token } = platform.backend;
  const headers = { authorization: `Bearer ${token}` };

  const rpcClient = createVibestClient({
    url: `${wsBaseUrl}/ws/rpc`,
    getTicket: async () => {
      const response = await fetch(`${httpBaseUrl}/api/ws-ticket`, { method: "POST", headers });
      if (!response.ok) {
        throw new Error(`Failed to obtain a WebSocket ticket: ${response.status}`);
      }
      const body = (await response.json()) as { ticket: string };
      return body.ticket;
    },
  });

  return { queryClient, rpcClient, orpc: createTanstackQueryUtils(rpcClient) };
}
