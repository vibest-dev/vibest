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
  readonly contentVisible: boolean;
  readonly maximized: boolean;
  readonly setMainCollapsed: (collapsed: boolean) => void;
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
  const { maximized } = useAppShell();
  if (isMobile) return <>{children}</>;
  return (
    <>
      <ShellSidebarPanel>{children}</ShellSidebarPanel>
      <ShellSeparator disabled={maximized} />
    </>
  );
}

export function AppShellMain({ children }: AppShellSlotProps) {
  const { isMobile } = useSidebar();
  const { contentVisible, maximized, setMainCollapsed } = useAppShell();
  return (
    <ShellMainPanel
      hasContentPanel={contentVisible}
      collapsed={maximized}
      collapsible={maximized || (contentVisible && !isMobile)}
      onCollapsedChange={setMainCollapsed}
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
  const contentVisible = presentation !== "hidden" && session !== null;
  const maximized = presentation === "maximized";
  const setMainCollapsed = useCallback(
    (collapsed: boolean) => session?.setPresentation(collapsed ? "maximized" : "docked"),
    [session],
  );
  const context = useMemo(
    () => ({ contentVisible, maximized, setMainCollapsed }),
    [contentVisible, maximized, setMainCollapsed],
  );

  return (
    <AppShellContext value={context}>
      <ShellGroup hasContentPanel={contentVisible} hasSidebar={!isMobile}>
        {children}
        {contentVisible && (
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
