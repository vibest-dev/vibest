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

const rpcLink = new RPCLink({
  url: `${window.location.origin}/api/rpc`,
});

function createWebSocketUrl() {
  const url = new URL("/ws/rpc", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const webSocketLink = new WebSocketRPCLink({
  websocket: new WebSocket(createWebSocketUrl(), "vibest"),
});
export const orpcClient: RouterClient<Router> = createORPCClient(rpcLink);
export const orpcWsClient: RouterClient<Router> = createORPCClient(webSocketLink);

export const orpc = createTanstackQueryUtils({
  orpcClient,
});
