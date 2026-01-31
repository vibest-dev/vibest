import type { QueryClient } from "@tanstack/react-query";

import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { NavigationProgress } from "@/components/navigation-progress";
import { Toaster } from "@/components/ui/sonner";
import GeneralError from "@/features/errors/general-error";
import NotFoundError from "@/features/errors/not-found-error";
// import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: () => {
    return (
      <>
        <NavigationProgress />
        <Outlet />
        <Toaster duration={50000} />
        {import.meta.env.MODE === "development" && (
          <>
            <ReactQueryDevtools buttonPosition="bottom-left" />
            {/* <TanStackRouterDevtools position='bottom-right' /> */}
          </>
        )}
      </>
    );
  },
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
});
