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
import { useRelocatablePortal } from "@/components/layout/use-relocatable-portal";

export interface AppShellProps {
  hasTrafficLights: boolean;
  onNewChat: () => void;
}

export function AppShell({ hasTrafficLights, onNewChat }: AppShellProps) {
  const { isMobile } = useSidebar();
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";
  const cardPanel = useRelocatablePortal(<CardPanel hasTrafficLights={hasTrafficLights} />, {
    hostClassName: "flex min-h-0 min-w-0 flex-1",
    key: "card-panel",
  });

  if (isMobile) {
    return (
      <>
        {cardPanel.portal}
        <AppSidebar onNewChat={onNewChat} />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            ref={cardPanel.mount}
            aria-hidden={contentVisible || undefined}
            className="flex min-h-0 min-w-0 flex-1"
            inert={contentVisible || undefined}
          />
          {contentVisible && (
            <div className="bg-background absolute inset-0 z-10 flex min-h-0 min-w-0">
              <ContentPanelOutlet />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {cardPanel.portal}
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
          <div ref={cardPanel.mount} className="flex min-h-0 min-w-0 flex-1" />
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
    </>
  );
}
