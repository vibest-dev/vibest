import {
  Splitter,
  SplitterPanel,
  SplitterResizeTrigger,
  SplitterResizeTriggerIndicator,
} from "@vibest/ui/components/splitter";
import { Fragment } from "react";

import { useAppStoreShallow } from "../../stores/app-store";
import { SplitPane } from "./split-pane";

interface SplitRootProps {
  activeSplitId: string | null;
  onActivateSplit: (splitId: string) => void;
  onNewTab: (splitId: string, viewType: string) => void;
}

export function SplitRoot({
  activeSplitId,
  onActivateSplit,
  onNewTab,
}: SplitRootProps) {
  const splitOrder = useAppStoreShallow((s) => s.workbench.splits.map((sp) => sp.id));

  if (splitOrder.length === 0) {
    return null;
  }

  if (splitOrder.length === 1) {
    const splitId = splitOrder[0]!;
    return (
      <SplitPane
        splitId={splitId}
        isActive={splitId === activeSplitId}
        onNewTab={onNewTab}
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
            <div onMouseDown={() => onActivateSplit(splitId)} className="h-full">
              <SplitPane
                splitId={splitId}
                isActive={splitId === activeSplitId}
                onNewTab={onNewTab}
              />
            </div>
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
