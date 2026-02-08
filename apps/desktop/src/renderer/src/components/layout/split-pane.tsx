import type { Worktree } from "../../types";
import type { PaneLeaf as PaneLeafModel } from "./split-state";

import { cn } from "../../lib/utils";
import { PaneLeaf } from "./pane-leaf";
import { PaneTabs } from "./pane-tabs";

interface SplitPaneProps {
  splitId: string;
  isActive: boolean;
  tabs: PaneLeafModel[];
  activeTabId: string | null;
  selectedWorktree: Worktree | null;
  onActivateSplit: (splitId: string) => void;
  onActivateTab: (splitId: string, tabId: string) => void;
  onOpenLeaf: (splitId: string, kind: string) => void;
  onCloseTab: (splitId: string, tabId: string) => void;
}

export function SplitPane({
  splitId,
  isActive,
  tabs,
  activeTabId,
  selectedWorktree,
  onActivateSplit,
  onActivateTab,
  onOpenLeaf,
  onCloseTab,
}: SplitPaneProps) {
  const activeLeaf = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  return (
    <div
      className={cn(
        "bg-background flex h-full min-h-0 min-w-0 flex-col",
        isActive ? "ring-primary/30 ring-1" : "",
      )}
      onMouseDown={() => onActivateSplit(splitId)}
    >
      <PaneTabs
        splitId={splitId}
        tabs={tabs}
        activeTabId={activeLeaf?.id ?? null}
        onActivateTab={onActivateTab}
        onOpenLeaf={onOpenLeaf}
        onCloseTab={onCloseTab}
      />
      <div className="min-h-0 flex-1">
        <PaneLeaf leaf={activeLeaf} selectedWorktree={selectedWorktree} />
      </div>
    </div>
  );
}
