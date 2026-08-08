import { Outlet } from "@tanstack/react-router";
import { SidebarInset, useSidebar } from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";

import { usePanelSnapshot } from "@/components/layout/content-panel/react/hooks";
import { ContentPanelToggle } from "@/components/layout/content-panel/react/toggle";

export function CardPanel() {
  const { state, isMobile } = useSidebar();
  // The fixed toggle sits over this header. Reserve its coarse-pointer hit
  // target on mobile; collapsed desktop also has to clear the traffic lights.
  const collapsedDesktop = !isMobile && state === "collapsed";
  // Maximizing squeezes this card to nothing rather than unmounting it: the
  // route lives inside, and unmounting would dispose the composer's editor.
  const maximized = usePanelSnapshot((snapshot) => snapshot.presentation === "maximized");

  return (
    <SidebarInset
      className={cn(
        "flex min-h-0 flex-col overflow-hidden border [-webkit-app-region:no-drag] md:peer-data-[variant=inset]:m-1.5 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-1.5",
        // Border and rounding off too — at zero width they would draw a sliver.
        maximized && "w-0 flex-none border-0 md:peer-data-[variant=inset]:rounded-none",
      )}
    >
      <header
        className={cn(
          // Divider is a box-shadow (no layout space) so it can't nudge the
          // title off the light line; transition animates the collapse-time
          // padding shift in sync with the sidebar slide.
          "flex h-10 shrink-0 items-center gap-2 px-4 shadow-[inset_0_-1px_0_var(--color-border)] transition-[padding] duration-200 ease-linear [-webkit-app-region:drag]",
          isMobile && "ps-14",
          collapsedDesktop && "ps-30",
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">New chat</span>
          <span className="text-muted-foreground">Playground</span>
        </div>
        <ContentPanelToggle className="ms-auto [-webkit-app-region:no-drag]" />
      </header>
      {/*
       * Always the Outlet, never a router-state-driven swap: `isLoading` flips
       * on *every* navigation, including a same-route search-param change like
       * /draft?projectId=…, and swapping the Outlet out unmounts the active
       * route — which would dispose the draft composer's editor and drop
       * whatever the user had typed. Slow route loaders are already covered by
       * the router's own `defaultPendingComponent` (see router.tsx).
       */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </SidebarInset>
  );
}
