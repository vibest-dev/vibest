import { useSidebar } from "@vibest/ui/components/sidebar";
import type { ReactNode } from "react";

import { useContentPanel, usePanelSnapshot } from "@/components/layout/content-panel/react/hooks";
import { ContentPanelOutlet } from "@/components/layout/content-panel/react/outlet";
import {
  ShellContentPanel,
  ShellGroup,
  ShellMainPanel,
  ShellSeparator,
  ShellSidebarPanel,
} from "@/components/layout/shell-panels";

/** Structural shell only; the root composition owns the semantic surfaces. */
export interface AppShellProps {
  readonly children: ReactNode;
  readonly sidebar: ReactNode;
}

export function AppShell({ children, sidebar }: AppShellProps) {
  const { isMobile } = useSidebar();
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";

  return (
    <>
      {isMobile && sidebar}
      <ShellGroup hasContentPanel={contentVisible} hasSidebar={!isMobile}>
        {!isMobile && (
          <>
            <ShellSidebarPanel>{sidebar}</ShellSidebarPanel>
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
          {children}
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
