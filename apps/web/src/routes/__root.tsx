import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouterState } from "@tanstack/react-router";

import Loader from "@/components/loader";
import type { orpc } from "@/lib/orpc";

export interface RouterAppContext {
  orpc: typeof orpc;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootLayout,
});

function RootLayout() {
  const isFetching = useRouterState({ select: (s) => s.isLoading });
  return (
    <div className="flex h-svh w-full">
      <main className="flex-1 overflow-hidden">{isFetching ? <Loader /> : <Outlet />}</main>
    </div>
  );
}
