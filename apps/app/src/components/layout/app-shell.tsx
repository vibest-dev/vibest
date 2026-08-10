import { SidebarProvider, useSidebar } from "@vibest/ui/components/sidebar";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { CardPanel } from "@/components/layout/card-panel";
import { useContentPanel, usePanelSnapshot } from "@/components/layout/content-panel/react/hooks";
import { ContentPanelOutlet } from "@/components/layout/content-panel/react/outlet";
import {
  ShellContentPanel,
  ShellGroup,
  ShellMainPanel,
  ShellSeparator,
  ShellSidebarPanel,
} from "@/components/layout/shell-panels";

/** Restore the state persisted by SidebarProvider. */
function readSidebarCookie(): boolean {
  return !document.cookie.includes("sidebar_state=false");
}

export function AppShell() {
  return (
    // -webkit-app-region drags the desktop window (no-op in the browser).
    // h-svh pins the shell to the viewport: the provider's own min-h-svh leaves
    // the height auto, so a long transcript would stretch the whole card and
    // scroll the document instead of the message list.
    <SidebarProvider
      className="bg-sidebar h-svh overflow-hidden [-webkit-app-region:drag]"
      defaultOpen={readSidebarCookie()}
    >
      <ResponsiveAppShell />
    </SidebarProvider>
  );
}

function ResponsiveAppShell() {
  const { isMobile } = useSidebar();
  return isMobile ? <MobileAppShell /> : <ResizableAppShell />;
}

function MobileAppShell() {
  const contentVisible = usePanelSnapshot((snapshot) => snapshot.presentation !== "hidden");

  return (
    <>
      <AppSidebar />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          aria-hidden={contentVisible || undefined}
          className="flex min-h-0 min-w-0 flex-1"
          inert={contentVisible || undefined}
        >
          <CardPanel />
        </div>
        {contentVisible && (
          <div className="bg-background absolute inset-0 z-10 flex min-h-0 min-w-0">
            <ContentPanelOutlet />
          </div>
        )}
      </div>
    </>
  );
}

function ResizableAppShell() {
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";

  return (
    <ShellGroup hasContentPanel={contentVisible} hasSidebar>
      <ShellSidebarPanel>
        <AppSidebar />
      </ShellSidebarPanel>
      <ShellSeparator disabled={maximized} />
      <ShellMainPanel
        hasContentPanel={contentVisible}
        collapsed={maximized}
        collapsible={maximized || contentVisible}
        onCollapsedChange={(collapsed) =>
          session?.setPresentation(collapsed ? "maximized" : "docked")
        }
      >
        <CardPanel />
      </ShellMainPanel>
      {contentVisible && (
        <>
          <ShellSeparator />
          <ShellContentPanel>
            <ContentPanelOutlet />
          </ShellContentPanel>
        </>
      )}
    </ShellGroup>
  );
}
