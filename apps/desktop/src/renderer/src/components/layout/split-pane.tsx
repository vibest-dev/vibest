import { cn } from "../../lib/utils";
import { ContentRenderer } from "./content-renderer";
import { TabBar } from "./tab-bar";

interface SplitPaneProps {
  splitId: string;
  isActive: boolean;
  onNewTab: (splitId: string, viewType: string) => void;
}

export function SplitPane({ splitId, isActive, onNewTab }: SplitPaneProps) {
  return (
    <div
      className={cn(
        "bg-background flex h-full min-h-0 min-w-0 flex-col",
        isActive ? "ring-primary/30 ring-1" : "",
      )}
    >
      <TabBar splitId={splitId} onNewTab={onNewTab} />
      <div className="min-h-0 flex-1">
        <ContentRenderer splitId={splitId} />
      </div>
    </div>
  );
}
