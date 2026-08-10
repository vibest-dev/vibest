import { useSidebar } from "@vibest/ui/components/sidebar";
import { createContext, type ReactNode, use, useCallback, useMemo } from "react";

import { useContentPanel, usePanelSnapshot } from "@/components/layout/content-panel/react/hooks";
import { ContentPanelOutlet } from "@/components/layout/content-panel/react/outlet";
import {
  ShellContentPanel,
  ShellGroup,
  ShellMainPanel,
  ShellSeparator,
  ShellSidebarPanel,
} from "@/components/layout/shell-panels";

interface AppShellContextValue {
  /** Whether the session-bound content-panel column is mounted. */
  readonly hasVisibleContentPanel: boolean;
  /** Whether the content panel fills the shell and collapses the main column. */
  readonly isContentPanelMaximized: boolean;
  /** Switch the content panel between maximized and docked presentation. */
  readonly setContentPanelMaximized: (maximized: boolean) => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

const useAppShell = (): AppShellContextValue => {
  const value = use(AppShellContext);
  if (value === null) throw new Error("AppShell composition must be rendered inside AppShell");
  return value;
};

export interface AppShellSlotProps {
  readonly children: ReactNode;
}

export function AppShellSidebar({ children }: AppShellSlotProps) {
  const { isMobile } = useSidebar();
  const { isContentPanelMaximized } = useAppShell();
  if (isMobile) return <>{children}</>;
  return (
    <>
      <ShellSidebarPanel>{children}</ShellSidebarPanel>
      <ShellSeparator disabled={isContentPanelMaximized} />
    </>
  );
}

export function AppShellMain({ children }: AppShellSlotProps) {
  const { isMobile } = useSidebar();
  const { hasVisibleContentPanel, isContentPanelMaximized, setContentPanelMaximized } =
    useAppShell();
  return (
    <ShellMainPanel
      hasContentPanel={hasVisibleContentPanel}
      collapsed={isContentPanelMaximized}
      collapsible={isContentPanelMaximized || (hasVisibleContentPanel && !isMobile)}
      onCollapsedChange={setContentPanelMaximized}
    >
      {children}
    </ShellMainPanel>
  );
}

/** Structural shell only; the root composition owns the semantic surfaces. */
export interface AppShellRootProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellRootProps) {
  const { isMobile } = useSidebar();
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const hasVisibleContentPanel = presentation !== "hidden" && session !== null;
  const isContentPanelMaximized = presentation === "maximized";
  const setContentPanelMaximized = useCallback(
    (maximized: boolean) => session?.setPresentation(maximized ? "maximized" : "docked"),
    [session],
  );
  const context = useMemo(
    () => ({ hasVisibleContentPanel, isContentPanelMaximized, setContentPanelMaximized }),
    [hasVisibleContentPanel, isContentPanelMaximized, setContentPanelMaximized],
  );

  return (
    <AppShellContext value={context}>
      <ShellGroup hasContentPanel={hasVisibleContentPanel} hasSidebar={!isMobile}>
        {children}
        {hasVisibleContentPanel && (
          <>
            <ShellSeparator />
            <ShellContentPanel>
              <ContentPanelOutlet />
            </ShellContentPanel>
          </>
        )}
      </ShellGroup>
    </AppShellContext>
  );
}
