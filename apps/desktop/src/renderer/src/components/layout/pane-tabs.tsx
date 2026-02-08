import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import { FileDiff, Plus, TerminalSquare, X } from "lucide-react";

import type { PaneLeaf } from "./split-state";

import { cn } from "../../lib/utils";

interface PaneTabsProps {
  splitId: string;
  tabs: PaneLeaf[];
  activeTabId: string | null;
  onActivateTab: (splitId: string, tabId: string) => void;
  onOpenLeaf: (splitId: string, kind: string) => void;
  onCloseTab: (splitId: string, tabId: string) => void;
}

function getKindLabel(kind: string): string {
  if (kind === "terminal") return "Terminal";
  if (kind === "diff") return "Diff";
  return kind;
}

export function PaneTabs({
  splitId,
  tabs,
  activeTabId,
  onActivateTab,
  onOpenLeaf,
  onCloseTab,
}: PaneTabsProps) {
  return (
    <div className="border-border bg-background/80 flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.length === 0 ? (
          <span className="text-muted-foreground text-xs">No tabs</span>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onActivateTab(splitId, tab.id)}
                className={cn(
                  "hover:bg-accent flex h-7 items-center gap-1 rounded px-2 text-xs",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                <span className="truncate">{tab.title || getKindLabel(tab.kind)}</span>
                <span
                  className="hover:bg-foreground/10 rounded p-0.5"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(splitId, tab.id);
                  }}
                >
                  <X className="size-3" />
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <Menu>
          <MenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 items-center gap-1 rounded px-2 text-xs">
            <Plus className="size-3.5" />
            New tab
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem onClick={() => onOpenLeaf(splitId, "terminal")}>
              <TerminalSquare className="size-4" />
              Terminal
            </MenuItem>
            <MenuItem onClick={() => onOpenLeaf(splitId, "diff")}>
              <FileDiff className="size-4" />
              Diff
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
