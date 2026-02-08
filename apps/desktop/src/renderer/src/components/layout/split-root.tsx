import {
  Splitter,
  SplitterPanel,
  SplitterResizeTrigger,
  SplitterResizeTriggerIndicator,
} from "@vibest/ui/components/splitter";
import { Fragment } from "react";

import type { Worktree } from "../../types";
import type { PaneLeaf } from "./split-state";

import { SplitPane } from "./split-pane";

interface SplitRootProps {
  splitOrder: string[];
  activeSplitId: string;
  tabsBySplitId: Record<string, PaneLeaf[]>;
  activeTabBySplitId: Record<string, string | null>;
  selectedWorktree: Worktree | null;
  onActivateSplit: (splitId: string) => void;
  onActivateTab: (splitId: string, tabId: string) => void;
  onOpenLeaf: (splitId: string, kind: string) => void;
  onCloseTab: (splitId: string, tabId: string) => void;
}

export function SplitRoot({
  splitOrder,
  activeSplitId,
  tabsBySplitId,
  activeTabBySplitId,
  selectedWorktree,
  onActivateSplit,
  onActivateTab,
  onOpenLeaf,
  onCloseTab,
}: SplitRootProps) {
  if (splitOrder.length === 0) {
    return null;
  }

  if (splitOrder.length === 1) {
    const splitId = splitOrder[0]!;
    return (
      <SplitPane
        splitId={splitId}
        isActive={splitId === activeSplitId}
        tabs={tabsBySplitId[splitId] ?? []}
        activeTabId={activeTabBySplitId[splitId] ?? null}
        selectedWorktree={selectedWorktree}
        onActivateSplit={onActivateSplit}
        onActivateTab={onActivateTab}
        onOpenLeaf={onOpenLeaf}
        onCloseTab={onCloseTab}
      />
    );
  }

  const defaultSize = splitOrder.map(() => 100 / splitOrder.length);
  const panels = splitOrder.map((splitId) => ({
    id: splitId,
    minSize: 20,
  }));

  return (
    <Splitter
      key={splitOrder.join("|")}
      className="h-full"
      defaultSize={defaultSize}
      panels={panels}
    >
      {splitOrder.map((splitId, index) => (
        <Fragment key={splitId}>
          <SplitterPanel id={splitId}>
            <SplitPane
              splitId={splitId}
              isActive={splitId === activeSplitId}
              tabs={tabsBySplitId[splitId] ?? []}
              activeTabId={activeTabBySplitId[splitId] ?? null}
              selectedWorktree={selectedWorktree}
              onActivateSplit={onActivateSplit}
              onActivateTab={onActivateTab}
              onOpenLeaf={onOpenLeaf}
              onCloseTab={onCloseTab}
            />
          </SplitterPanel>
          {index < splitOrder.length - 1 && (
            <SplitterResizeTrigger id={`${splitId}:${splitOrder[index + 1]!}`}>
              <SplitterResizeTriggerIndicator />
            </SplitterResizeTrigger>
          )}
        </Fragment>
      ))}
    </Splitter>
  );
}
