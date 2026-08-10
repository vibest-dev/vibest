import { useSidebar } from "@vibest/ui/components/sidebar";

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

export interface AppShellProps {
  hasTrafficLights: boolean;
  onNewChat: () => void;
}

export function AppShell(props: AppShellProps) {
  const { isMobile } = useSidebar();
  return isMobile ? <MobileAppShell {...props} /> : <ResizableAppShell {...props} />;
}

function MobileAppShell({ hasTrafficLights, onNewChat }: AppShellProps) {
  const contentVisible = usePanelSnapshot((snapshot) => snapshot.presentation !== "hidden");

  return (
    <>
      <AppSidebar onNewChat={onNewChat} />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          aria-hidden={contentVisible || undefined}
          className="flex min-h-0 min-w-0 flex-1"
          inert={contentVisible || undefined}
        >
          <CardPanel hasTrafficLights={hasTrafficLights} />
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

function ResizableAppShell({ hasTrafficLights, onNewChat }: AppShellProps) {
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";

  return (
    <ShellGroup hasContentPanel={contentVisible} hasSidebar>
      <ShellSidebarPanel>
        <AppSidebar onNewChat={onNewChat} />
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
        <CardPanel hasTrafficLights={hasTrafficLights} />
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
