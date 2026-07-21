import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";

import { AppSidebar } from "@/components/layout/app-sidebar";
import Loader from "@/components/loader";
import type { AppClients } from "@/lib/orpc";

export interface RouterAppContext {
  orpcQueryUtils: AppClients["orpcQueryUtils"];
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Negotiate harness capabilities once, right after the client connects and
  // before any route renders — the MCP `initialize` analogue. Every consumer
  // (e.g. the permission-mode picker) then reads the held result by id.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      context.orpcQueryUtils.harness.negotiate.queryOptions({ input: {} }),
    ),
  component: RootLayout,
});

// Global shell: left sidebar + floating card panel; every route renders in the card.
function RootLayout() {
  const isFetching = useRouterState({ select: (s) => s.isLoading });
  const navigate = useNavigate();

  const handleNewChat = () => navigate({ to: "/draft" });

  return (
    // -webkit-app-region drags the desktop window (no-op in the browser).
    // h-svh pins the shell to the viewport: the provider's own min-h-svh leaves
    // the height auto, so a long transcript would stretch the whole card and
    // scroll the document instead of the message list.
    <SidebarProvider className="h-svh overflow-hidden [-webkit-app-region:drag]">
      <AppSidebar onNewChat={handleNewChat} />
      <CardPanel isFetching={isFetching} />
      {/*
       * Single fixed toggle for every state: the offcanvas sidebar would carry
       * an inside toggle off-screen on collapse, and swapping two copies
       * flickers. top-11/left-22 sits it on the macOS traffic-light row.
       */}
      <SidebarTrigger className="fixed top-[11px] left-22 z-30 [-webkit-app-region:no-drag]" />
    </SidebarProvider>
  );
}

// Split out so it can read sidebar state via useSidebar().
function CardPanel({ isFetching }: { isFetching: boolean }) {
  const { state, isMobile } = useSidebar();
  // Collapsed, the card slides under the toggle + traffic lights — pad so the
  // title clears them.
  const collapsedDesktop = !isMobile && state === "collapsed";

  return (
    <SidebarInset className="flex min-h-0 flex-col overflow-hidden border [-webkit-app-region:no-drag] md:peer-data-[variant=inset]:m-1.5 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-1.5">
      <header
        className={cn(
          // Divider is a box-shadow (no layout space) so it can't nudge the
          // title off the light line; transition animates the collapse-time
          // padding shift in sync with the sidebar slide.
          "flex h-10 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-1px_0_var(--color-border)] transition-[padding] duration-200 ease-linear [-webkit-app-region:drag]",
          collapsedDesktop && "ps-30",
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">New chat</span>
          <span className="text-muted-foreground">Playground</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isFetching ? <Loader /> : <Outlet />}
      </div>
    </SidebarInset>
  );
}
