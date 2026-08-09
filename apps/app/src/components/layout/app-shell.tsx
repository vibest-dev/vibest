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
  projectName: string | undefined;
  title: string;
}

export function AppShell({ hasTrafficLights, onNewChat, projectName, title }: AppShellProps) {
  const { isMobile } = useSidebar();
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";

  return (
    <>
      {isMobile && <AppSidebar onNewChat={onNewChat} />}
      <ShellGroup hasContentPanel={contentVisible} hasSidebar={!isMobile}>
        {!isMobile && (
          <>
            <ShellSidebarPanel>
              <AppSidebar onNewChat={onNewChat} />
            </ShellSidebarPanel>
            <ShellSeparator disabled={maximized} />
          </>
        )}
        <ShellMainPanel
          hasContentPanel={contentVisible}
          collapsed={maximized}
          collapsible={maximized || (contentVisible && !isMobile)}
          onCollapsedChange={(collapsed) =>
            session?.setPresentation(collapsed ? "maximized" : "docked")
          }
        >
          <CardPanel hasTrafficLights={hasTrafficLights} projectName={projectName} title={title} />
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
