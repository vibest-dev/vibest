import { Button } from "@vibest/ui/components/button";
import { Empty, EmptyContent, EmptyDescription } from "@vibest/ui/components/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import { cn } from "@vibest/ui/lib/utils";
import { Maximize2Icon, Minimize2Icon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, useEffect, useRef, type ReactNode } from "react";

import type { OpenPanel } from "../core/content-panel";
import { type ContentPanelSession, useContentPanel, usePanelSnapshot } from "./hooks";
import type { AnyPanelView } from "./view";

/**
 * Where the active panel renders: its own card beside the chat's, its tab strip,
 * and the empty state. Knows nothing about any particular panel — everything it
 * shows comes off the snapshot.
 *
 * A card, not a column inside the chat's: the two are siblings that each own
 * their chrome, so the panel's tab strip is its own header line rather than a
 * tenant of the chat's. The margins mirror `SidebarInset`'s so the gap between
 * the cards matches the gap to the sidebar.
 */
export type ContentPanelOutletProps = ComponentProps<"aside">;

export function ContentPanelOutlet({ className, ...props }: ContentPanelOutletProps): ReactNode {
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  const session = useContentPanel();

  // Off a session the snapshot is always hidden, so the first clause covers it;
  // the second is what narrows `session` for everything below.
  if (presentation === "hidden" || session === null) return null;

  return (
    <aside
      data-slot="content-panel"
      data-state={presentation}
      className={cn(
        "bg-background relative flex min-h-0 min-w-0 flex-col overflow-hidden border [-webkit-app-region:no-drag]",
        "md:my-1.5 md:me-1.5 md:rounded-xl md:shadow-sm/5",
        presentation === "maximized" ? "flex-1" : "w-112 shrink-0",
        className,
      )}
      {...props}
    >
      <TabStrip presentation={presentation} session={session} />
      <PanelBody session={session} />
    </aside>
  );
}

function TabStrip({
  presentation,
  session,
}: {
  presentation: "docked" | "maximized";
  session: ContentPanelSession;
}): ReactNode {
  const panels = usePanelSnapshot((snapshot) => snapshot.panels);
  const activeId = usePanelSnapshot((snapshot) => snapshot.active?.id ?? null);
  const scroller = useRef<HTMLDivElement>(null);

  // One effect here rather than one per tab: a scroll offset is not state to
  // derive, and the strip overflows well before it runs out of panels, so
  // without this the tab you just opened can land off the end of it.
  useEffect(() => {
    if (activeId === null) return;
    scroller.current
      ?.querySelector("[data-slot=content-panel-tab][data-active]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b ps-1.5 pe-1">
      {/*
       * The scroller sizes to its content and shrinks — it is deliberately not
       * `flex-1`. "+" is its sibling, so it stays pinned just past the last
       * visible tab instead of scrolling off the end with them. `scrollbar-hide`
       * because a bar here would eat the height it scrolls in.
       */}
      <div
        ref={scroller}
        className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto"
      >
        {panels.map((panel) => (
          <Tab key={panel.id} panel={panel} active={panel.id === activeId} session={session} />
        ))}
      </div>
      {panels.length > 0 ? <AddPanelMenu session={session} /> : null}
      <Button
        className="ms-auto"
        variant="ghost"
        size="icon-xs"
        aria-label={presentation === "maximized" ? "Restore panel size" : "Maximize panel"}
        onClick={() =>
          session.setPresentation(presentation === "maximized" ? "docked" : "maximized")
        }
      >
        {presentation === "maximized" ? (
          <Minimize2Icon className="size-3.5" />
        ) : (
          <Maximize2Icon className="size-3.5" />
        )}
      </Button>
      {/*
       * No hide button here: `ContentPanelToggle` already is one, and it has to
       * live outside the panel anyway to bring it back. Two controls for one
       * boolean is the duplication that button would be.
       */}
    </div>
  );
}

function Tab({
  panel,
  active,
  session,
}: {
  panel: OpenPanel<AnyPanelView>;
  active: boolean;
  session: ContentPanelSession;
}): ReactNode {
  const Icon = panel.view.icon;
  return (
    <div
      data-slot="content-panel-tab"
      // `data-active`, as both `tabs` and `sidebar` spell it. Also how the strip
      // finds the tab to scroll into view.
      data-active={active || undefined}
      className={cn(
        "group flex h-7 max-w-40 shrink-0 items-center gap-1 rounded-md ps-1.5 pe-1 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      // A middle click closes the tab, the way every tabbed thing does.
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        session.close(panel.id);
      }}
    >
      <button
        type="button"
        // Which tab is current must not be carried by the background alone.
        aria-current={active || undefined}
        className="flex min-w-0 items-center gap-1.5"
        onClick={() => session.activate(panel.id)}
        title={panel.label}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{panel.label}</span>
      </button>
      <button
        type="button"
        className="hover:bg-muted flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Close ${panel.label}`}
        onClick={() => session.close(panel.id)}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

function AddPanelMenu({ session }: { session: ContentPanelSession }): ReactNode {
  const openable = usePanelSnapshot((snapshot) => snapshot.openable);
  if (openable.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger
        className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-md"
        aria-label="Open a panel"
      >
        <PlusIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-44">
        {openable.map((entry) => {
          const Icon = entry.view.icon;
          return (
            <MenuItem key={entry.type} onClick={() => session.openNew(entry.type)}>
              <Icon className="size-4" />
              {entry.title}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function PanelBody({ session }: { session: ContentPanelSession }): ReactNode {
  const active = usePanelSnapshot((snapshot) => snapshot.active);
  if (active === null) return <EmptyState session={session} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Reading `instance` is what materializes the panel — only this one. */}
      {active.view.render(active.instance)}
    </div>
  );
}

function EmptyState({ session }: { session: ContentPanelSession }): ReactNode {
  const openable = usePanelSnapshot((snapshot) => snapshot.openable);
  return (
    <Empty className="py-6 md:py-6">
      <EmptyContent>
        <EmptyDescription>Choose what to show alongside the chat.</EmptyDescription>
        {/*
         * Ghost buttons, not bordered tiles: this is already inside the panel's
         * card, and cards do not nest (design.md). The published Button carries
         * the hover, focus ring and coarse-pointer step for free.
         */}
        <div className="grid w-full grid-cols-2 gap-1">
          {openable.map((entry) => {
            const Icon = entry.view.icon;
            return (
              <Button
                key={entry.type}
                variant="ghost"
                className="justify-start"
                onClick={() => session.openNew(entry.type)}
              >
                <Icon />
                {entry.title}
              </Button>
            );
          })}
        </div>
      </EmptyContent>
    </Empty>
  );
}
