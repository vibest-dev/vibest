import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import Loader from "./components/loader";
import type { AppClients } from "./lib/orpc";
import { routeTree } from "./routeTree.gen";

export const createRouter = (clients: AppClients) => {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: { orpc: clients.orpc, queryClient: clients.queryClient },
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <div>Not Found</div>,
  });
  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
