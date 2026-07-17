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
  component: RootLayout,
});

// The whole app lives inside this shell: a left sidebar and a floating card
// panel. Every route — landing, session, everything — renders in the card.
function RootLayout() {
  const isFetching = useRouterState({ select: (s) => s.isLoading });
  const { orpcQueryUtils } = Route.useRouteContext();
  const navigate = useNavigate();

  const handleNewChat = async () => {
    try {
      const { sessionId } = await orpcQueryUtils.session.create.call({
        harnessAgentId: "claude-code",
      });
      navigate({ to: "/session/$sessionId", params: { sessionId } });
    } catch (error) {
      console.error("Failed to create session", error);
    }
  };

  return (
    <SidebarProvider>
      <AppSidebar onNewChat={handleNewChat} />
      <CardPanel isFetching={isFetching} />
      {/*
       * One pinned toggle for every state. The sidebar is offcanvas, so a toggle
       * living inside it would vanish on collapse; swapping between a sidebar
       * copy and a card-header copy also flickers on toggle. A single fixed
       * button at the traffic-light row stays put — no mount/unmount, no jump.
       * top-11 (32px button) centers it on window-Y 27, the traffic-light line;
       * left-22 clears the macOS traffic lights with a small gap.
       */}
      <SidebarTrigger className="fixed top-[11px] left-22 z-30" />
    </SidebarProvider>
  );
}

// The floating card. Split out so it can read sidebar state via useSidebar()
// (a hook only usable below SidebarProvider).
function CardPanel({ isFetching }: { isFetching: boolean }) {
  const { state, isMobile } = useSidebar();
  // Collapsed on desktop, the card slides left under the pinned toggle and the
  // macOS traffic lights — pad the header start so the title clears them.
  const collapsedDesktop = !isMobile && state === "collapsed";

  return (
    <SidebarInset className="flex min-h-0 flex-col overflow-hidden border md:peer-data-[variant=inset]:m-1.5 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-1.5">
      <header
        className={cn(
          // The bottom divider is an inset box-shadow, not a border: it takes no
          // layout space, so it can't eat into this flex box and pull the
          // centered title off the traffic-light line.
          // transition-[padding] animates the collapse-time shift in sync with
          // the sidebar slide (matching its duration-200 ease-linear), so the
          // title glides aside to make room for the lights instead of jumping.
          "flex h-10 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-1px_0_var(--color-border)] transition-[padding] duration-200 ease-linear",
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
