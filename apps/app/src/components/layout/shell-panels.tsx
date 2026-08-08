import { useSidebar } from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react";
import {
  Group,
  Panel,
  type OnPanelResize,
  type PanelImperativeHandle,
  Separator,
  type SeparatorProps,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";

/** Resizable sidebar | chat | content-panel columns. */

const SHELL_LAYOUT_ID = "vibest:shell-layout";
const SIDEBAR_DEFAULT_SIZE = "16rem";

const PANEL_IDS = {
  content: "content",
  main: "main",
  sidebar: "sidebar",
} as const;

export function ShellGroup({
  hasSidebar,
  hasContentPanel,
  children,
}: {
  hasSidebar: boolean;
  hasContentPanel: boolean;
  children: ReactNode;
}): ReactNode {
  const panelIds = useMemo(
    () => [
      ...(hasSidebar ? [PANEL_IDS.sidebar] : []),
      PANEL_IDS.main,
      ...(hasContentPanel ? [PANEL_IDS.content] : []),
    ],
    [hasSidebar, hasContentPanel],
  );
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: SHELL_LAYOUT_ID,
    // Do not persist transient imperative collapses.
    onlySaveAfterUserInteractions: true,
    panelIds,
    storage: localStorage,
  });

  return (
    <Group
      className="flex min-h-0 w-full flex-1"
      defaultLayout={defaultLayout}
      resizeTargetMinimumSize={{ coarse: 28, fine: 18 }}
      onLayoutChanged={(layout, meta) => {
        // Preserve the last expanded widths.
        if (Object.values(layout).some((size) => size === 0)) return;
        onLayoutChanged(layout, meta);
      }}
      orientation="horizontal"
    >
      {children}
    </Group>
  );
}

/** Inter-card gutter and resize handle. */
export function ShellSeparator({ className, disabled, ...props }: SeparatorProps): ReactNode {
  return (
    <Separator
      className={cn(
        "relative w-1.5 bg-transparent [-webkit-app-region:no-drag] md:my-1.5",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-[width,background-color]",
        "hover:after:bg-foreground/20 data-[separator=focus]:after:bg-foreground/20 data-[separator=active]:after:bg-primary data-[separator=active]:after:w-0.5",
        disabled && "w-0 after:hidden",
        className,
      )}
      disabled={disabled}
      {...props}
    />
  );
}

/** Binds app-owned collapsed state to the panel's imperative state. */
function useCollapsedBinding(
  panelRef: RefObject<PanelImperativeHandle | null>,
  collapsed: boolean,
  onCollapsedChange: (collapsed: boolean) => void,
  expandedSize: string,
): OnPanelResize {
  const laidOut = useRef(false);

  const sync = (panel: PanelImperativeHandle): void => {
    if (collapsed === panel.isCollapsed()) return;
    if (collapsed) {
      panel.collapse();
      return;
    }
    panel.expand();
    if (panel.isCollapsed()) panel.resize(expandedSize);
  };

  useEffect(() => {
    const panel = panelRef.current;
    // The imperative handle is only safe after the panel's first layout.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler
    if (panel === null || !laidOut.current) return;
    sync(panel);
    // `sync` closes over the current `collapsed` value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, panelRef]);

  return (size) => {
    const panel = panelRef.current;
    if (laidOut.current) {
      const isCollapsed = size.inPixels === 0;
      if (isCollapsed !== collapsed) onCollapsedChange(isCollapsed);
      return;
    }
    laidOut.current = true;
    if (panel !== null) sync(panel);
  };
}

export function ShellSidebarPanel({ children }: { children: ReactNode }): ReactNode {
  const { open, setOpen } = useSidebar();
  const panelRef = usePanelRef();
  const onResize = useCollapsedBinding(
    panelRef,
    !open,
    (collapsed) => setOpen(!collapsed),
    SIDEBAR_DEFAULT_SIZE,
  );

  return (
    <Panel
      className="flex min-w-0 flex-col overflow-hidden md:py-1.5 md:ps-1.5"
      collapsedSize={0}
      collapsible
      defaultSize={SIDEBAR_DEFAULT_SIZE}
      groupResizeBehavior="preserve-pixel-size"
      id={PANEL_IDS.sidebar}
      maxSize="30rem"
      minSize="12rem"
      onResize={onResize}
      panelRef={panelRef}
    >
      {children}
    </Panel>
  );
}

export function ShellMainPanel({
  hasContentPanel,
  collapsible,
  collapsed,
  onCollapsedChange,
  children,
}: {
  /** Whether the content column is mounted. */
  hasContentPanel: boolean;
  /** Whether the chat column may collapse. */
  collapsible: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  children: ReactNode;
}): ReactNode {
  const panelRef = usePanelRef();
  const onResize = useCollapsedBinding(panelRef, collapsed, onCollapsedChange, "50%");

  return (
    <Panel
      className={cn(
        "flex min-w-0 flex-col overflow-hidden md:py-1.5",
        !hasContentPanel && "md:pe-1.5",
      )}
      collapsedSize={0}
      collapsible={collapsible}
      id={PANEL_IDS.main}
      minSize="20rem"
      onResize={onResize}
      panelRef={panelRef}
    >
      {children}
    </Panel>
  );
}

export function ShellContentPanel({ children }: { children: ReactNode }): ReactNode {
  return (
    <Panel
      className="flex min-w-0 flex-col overflow-hidden md:py-1.5 md:pe-1.5"
      defaultSize="28rem"
      groupResizeBehavior="preserve-pixel-size"
      id={PANEL_IDS.content}
      minSize="18rem"
    >
      {children}
    </Panel>
  );
}
