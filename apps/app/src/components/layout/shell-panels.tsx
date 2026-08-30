import { useSidebar } from "@vibest/ui/components/sidebar";
import { cn } from "@vibest/ui/lib/utils";
import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from "motion/react";
import * as m from "motion/react-m";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
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
const SIDEBAR_MIN_SIZE = "12rem";

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

  const sync = useCallback(
    (panel: PanelImperativeHandle): void => {
      if (collapsed === panel.isCollapsed()) return;
      if (collapsed) {
        panel.collapse();
        return;
      }
      panel.expand();
      if (panel.isCollapsed()) panel.resize(expandedSize);
    },
    [collapsed, expandedSize],
  );

  useLayoutEffect(() => {
    const panel = panelRef.current;
    // The imperative handle is only safe after the panel's first layout.
    if (panel === null || !laidOut.current) return;
    sync(panel);
  }, [collapsed, panelRef, sync]);

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

/** True while the drawer width has not reached the `open` target. */
function sidebarDrawerInFlight(open: boolean, px: number, expandedPx: number): boolean {
  return open ? px < expandedPx - 0.5 : px > 0.5;
}

/**
 * Toggle springs the column width; the rail's `x` is `width - expanded` so the
 * contents slide as a drawer instead of squashing. Drag-resize stays a snap.
 * `minSize` is 0 while the spring is in flight — the panel group otherwise
 * refuses any `resize()` below 12rem.
 */
function useSidebarDrawer(
  open: boolean,
  setOpen: (open: boolean) => void,
  panelRef: RefObject<PanelImperativeHandle | null>,
) {
  const reduceMotion = useReducedMotion() === true;
  const laidOut = useRef(false);
  const skip = useRef(false);
  const flying = useRef(false);
  const expanded = useMotionValue(256);
  const width = useMotionValue(open ? 256 : 0);
  const x = useTransform(() => width.get() - expanded.get());
  const sync = useReducer((n: number) => n + 1, 0)[1];
  const inFlight = sidebarDrawerInFlight(open, width.get(), expanded.get());

  // Re-render when the spring or jump crosses the settle threshold so `inFlight`
  // (and therefore `minSize` / fill) can be derived again. The effect that
  // drives `animate` / `jump` must not `setState`.
  useMotionValueEvent(width, "change", (value) => {
    if (sidebarDrawerInFlight(open, value, expanded.get()) !== inFlight) {
      sync();
    }
  });

  const minSize = open && !inFlight ? SIDEBAR_MIN_SIZE : 0;

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || !laidOut.current) return;

    if (skip.current) {
      skip.current = false;
      width.jump(open ? expanded.get() : 0);
      flying.current = false;
      return;
    }

    if (reduceMotion) {
      width.jump(open ? expanded.get() : 0);
      if (open) {
        panel.expand();
        panel.resize(expanded.get());
      } else if (!panel.isCollapsed()) {
        panel.collapse();
      }
      flying.current = false;
      return;
    }

    flying.current = true;
    const controls = animate(width, open ? expanded.get() : 0, {
      onComplete() {
        flying.current = false;
      },
      onUpdate(value) {
        if (value <= 0.5) {
          if (!panel.isCollapsed()) panel.collapse();
          return;
        }
        panel.resize(value);
      },
    });
    return () => {
      flying.current = false;
      controls.stop();
    };
  }, [expanded, open, panelRef, reduceMotion, width]);

  const onResize: OnPanelResize = (size) => {
    const panel = panelRef.current;
    if (!laidOut.current) {
      laidOut.current = true;
      if (size.inPixels > 0) {
        expanded.set(size.inPixels);
        if (open) width.set(size.inPixels);
      }
      if (panel === null) return;
      if (!open && !panel.isCollapsed()) panel.collapse();
      if (open && panel.isCollapsed()) {
        panel.expand();
        if (panel.isCollapsed()) panel.resize(expanded.get());
      }
      return;
    }

    if (flying.current) return;

    if (size.inPixels > 0) {
      expanded.set(size.inPixels);
      width.set(size.inPixels);
    }

    const collapsed = size.inPixels === 0;
    if (collapsed === open) {
      skip.current = true;
      setOpen(!collapsed);
    }
  };

  return {
    fill: open && !inFlight,
    minSize,
    onResize,
    style: { width: expanded, x },
  };
}

export function ShellSidebarPanel({ children }: { children: ReactNode }): ReactNode {
  const { open, setOpen } = useSidebar();
  const panelRef = usePanelRef();
  const drawer = useSidebarDrawer(open, setOpen, panelRef);

  return (
    <Panel
      className="flex min-w-0 flex-col overflow-hidden md:py-1.5 md:ps-1.5"
      collapsedSize={0}
      collapsible
      defaultSize={SIDEBAR_DEFAULT_SIZE}
      groupResizeBehavior="preserve-pixel-size"
      id={PANEL_IDS.sidebar}
      maxSize="30rem"
      minSize={drawer.minSize}
      onResize={drawer.onResize}
      panelRef={panelRef}
    >
      <m.div
        className={cn("flex h-full min-h-0 flex-col", drawer.fill ? "w-full" : "shrink-0")}
        data-slot="sidebar-drawer"
        data-state={open ? "open" : "closed"}
        inert={!open}
        style={drawer.fill ? undefined : drawer.style}
      >
        {children}
      </m.div>
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
