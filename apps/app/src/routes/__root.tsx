import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useNavigate } from "@tanstack/react-router";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { useSessionListSync } from "@/features/projects/use-session-list-sync";
import type { AppClients } from "@/lib/orpc";
import { usePlatform } from "@/platform-context";

export interface RouterAppContext {
  orpcClient: AppClients["orpcClient"];
  orpcQueryUtils: AppClients["orpcQueryUtils"];
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Fetch the harness list once, right after the client connects and before
  // any route renders. Every consumer (e.g. the permission-mode picker) then
  // reads the held result by id.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      context.orpcQueryUtils.harness.list.queryOptions({ input: {} }),
    ),
  component: RootLayout,
});

// Global shell: left sidebar + floating card panel; every route renders in the card.
function RootLayout() {
  // Keeps every `session.list` cache converged from the server's events
  // (multi-tab / desktop), independent of which route is mounted.
  useSessionListSync();
  const navigate = useNavigate();
  const { os } = usePlatform();

  const handleNewChat = () => navigate({ to: "/draft" });

  return (
    // -webkit-app-region drags the desktop window (no-op in the browser).
    // h-svh pins the shell to the viewport: the provider's own min-h-svh leaves
    // the height auto, so a long transcript would stretch the whole card and
    // scroll the document instead of the message list.
    <SidebarProvider className="h-svh overflow-hidden [-webkit-app-region:drag]">
      <AppSidebar onNewChat={handleNewChat} />
      <CardPanel />
      <ShellToggle hasTrafficLights={os === "macos"} />
    </SidebarProvider>
  );
}

/**
 * Still one fixed toggle for every state rather than a copy inside the sidebar
 * and a copy outside it: the offcanvas sidebar carries an inside toggle
 * off-screen on collapse, and swapping two copies flickers. Only its x moves,
 * animated in step with the sidebar slide.
 *
 * Expanded it sits at the sidebar's inner right edge — `--sidebar-width` less
 * the sidebar's own p-1.5, the group's p-2, and the size-7 button. Collapsed it
 * takes the corner over, unless macOS's traffic lights already own it.
 */
function ShellToggle({ hasTrafficLights }: { hasTrafficLights: boolean }) {
  const { state, isMobile } = useSidebar();
  const expanded = !isMobile && state === "expanded";

  return (
    <SidebarTrigger
      className={cn(
        "fixed top-[11px] z-30 transition-[left] duration-200 ease-linear [-webkit-app-region:no-drag]",
        expanded
          ? "left-[calc(var(--sidebar-width)-3.375rem)]"
          : hasTrafficLights
            ? "left-22"
            : "left-2",
      )}
    />
  );
}

// Split out so it can read sidebar state via useSidebar().
function CardPanel() {
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
      {/*
       * Always the Outlet, never a router-state-driven swap: `isLoading` flips
       * on *every* navigation, including a same-route search-param change like
       * /draft?projectId=…, and swapping the Outlet out unmounts the active
       * route — which would dispose the draft composer's editor and drop
       * whatever the user had typed. Slow route loaders are already covered by
       * the router's own `defaultPendingComponent` (see router.tsx).
       */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </SidebarInset>
  );
}
