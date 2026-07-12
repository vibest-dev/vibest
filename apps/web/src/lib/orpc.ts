import type { RouterClient } from "@orpc/server";
import type { Router } from "@vibest/server-rpc/routes";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export const queryClient = new QueryClient({
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

// Served same-origin by the CLI server, so the RPC endpoint is a relative
// path (which is also what @orpc's StandardUrl type expects).
const rpcLink = new RPCLink({
  url: "/api/rpc",
});

function createWebSocketUrl() {
  const url = new URL("/ws/rpc", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

// beta.16 takes a lazy `connect` factory (connects on first use) instead of
// an eagerly created socket instance.
const webSocketLink = new WebSocketRPCLink({
  connect: () => new WebSocket(createWebSocketUrl(), "vibest"),
});
export const orpcClient: RouterClient<Router> = createORPCClient(rpcLink);
export const orpcWsClient: RouterClient<Router> = createORPCClient(webSocketLink);

export const orpc = createTanstackQueryUtils({
  orpcClient,
});
