import { useSidebar } from "@vibest/ui/components/sidebar";
import { Children, isValidElement, type ReactNode } from "react";

import { useContentPanel, usePanelSnapshot } from "@/components/layout/content-panel/react/hooks";
import { ContentPanelOutlet } from "@/components/layout/content-panel/react/outlet";
import {
  ShellContentPanel,
  ShellGroup,
  ShellMainPanel,
  ShellSeparator,
  ShellSidebarPanel,
} from "@/components/layout/shell-panels";

export interface AppShellSlotProps {
  readonly children: ReactNode;
}

export function AppShellSidebar({ children }: AppShellSlotProps) {
  return <>{children}</>;
}

export function AppShellMain({ children }: AppShellSlotProps) {
  return <>{children}</>;
}

const contentOf = (
  children: ReactNode,
  Slot: (props: AppShellSlotProps) => ReactNode,
): ReactNode => {
  for (const child of Children.toArray(children)) {
    if (isValidElement<AppShellSlotProps>(child) && child.type === Slot) {
      return child.props.children;
    }
  }
  return null;
};

/** Structural shell only; the root composition owns the semantic surfaces. */
export interface AppShellRootProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellRootProps) {
  const { isMobile } = useSidebar();
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";
  const sidebar = contentOf(children, AppShellSidebar);
  const main = contentOf(children, AppShellMain);

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
          {main}
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
