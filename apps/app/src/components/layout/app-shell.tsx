import { SidebarProvider, useSidebar } from "@vibest/ui/components/sidebar";
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
  readonly contentPanel: {
    /** Whether the session-bound content-panel column is mounted. */
    readonly visible: boolean;
    /** Whether the content panel fills the shell and collapses the main column. */
    readonly maximized: boolean;
    /** Switch the content panel between maximized and docked presentation. */
    readonly setMaximized: (maximized: boolean) => void;
  };
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

const useAppShell = (): AppShellContextValue => {
  const value = use(AppShellContext);
  if (value === null) {
    throw new Error("AppShellSidebar and AppShellMain must be rendered inside AppShellBody");
  }
  return value;
};

export interface AppShellSidebarProps {
  readonly children: ReactNode;
}

export function AppShellSidebar({ children }: AppShellSidebarProps) {
  const { isMobile } = useSidebar();
  const { contentPanel } = useAppShell();
  if (isMobile) return <>{children}</>;
  return (
    <>
      <ShellSidebarPanel>{children}</ShellSidebarPanel>
      <ShellSeparator disabled={contentPanel.maximized} />
    </>
  );
}

export interface AppShellMainProps {
  readonly children: ReactNode;
}

export function AppShellMain({ children }: AppShellMainProps) {
  const { isMobile } = useSidebar();
  const { contentPanel } = useAppShell();
  return (
    <ShellMainPanel
      hasContentPanel={contentPanel.visible}
      collapsed={contentPanel.maximized}
      collapsible={contentPanel.maximized || (contentPanel.visible && !isMobile)}
      onCollapsedChange={contentPanel.setMaximized}
    >
      {children}
    </ShellMainPanel>
  );
}

/** Restore the state persisted by SidebarProvider. */
const readSidebarCookie = (): boolean => !document.cookie.includes("sidebar_state=false");

/** Structural shell only; the root composition owns the semantic surfaces. */
export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    // The provider is shell-owned: it supplies responsive/sidebar state and is
    // also the viewport wrapper. The app-region rule drags desktop windows;
    // h-svh keeps long transcripts scrolling inside the card, not the document.
    <SidebarProvider
      className="bg-sidebar h-svh overflow-hidden [-webkit-app-region:drag]"
      defaultOpen={readSidebarCookie()}
    >
      {children}
    </SidebarProvider>
  );
}

export interface AppShellBodyProps {
  readonly children: ReactNode;
}

export function AppShellBody({ children }: AppShellBodyProps) {
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
    () => ({
      contentPanel: {
        visible: hasVisibleContentPanel,
        maximized: isContentPanelMaximized,
        setMaximized: setContentPanelMaximized,
      },
    }),
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
