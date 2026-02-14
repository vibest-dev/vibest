import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import { FileDiff, Plus, TerminalSquare, X } from "lucide-react";

import type { PartState } from "../../workbench/types";

import { cn } from "../../lib/utils";
import { useAppStore, useAppStoreShallow } from "../../stores/app-store";
import { workbench } from "../../workbench/workbench";

interface TabBarProps {
  splitId: string;
  onNewTab: (splitId: string, viewType: string) => void;
}

function getViewIcon(viewType: string) {
  if (viewType === "terminal") return <TerminalSquare className="size-3.5" />;
  if (viewType === "diff") return <FileDiff className="size-3.5" />;
  return null;
}

function getViewTypeLabel(viewType: string): string {
  if (viewType === "terminal") return "Terminal";
  if (viewType === "diff") return "Diff";
  return viewType;
}

function TabBarItem({
  part,
  isActive,
  splitId,
}: {
  part: PartState;
  isActive: boolean;
  splitId: string;
}) {
  const handleClick = () => {
    const split = workbench.getSplit(splitId);
    if (!split) return;
    const p = split.parts.get(part.id);
    if (p) split.setActivePart(p);
  };

  const handleClose = (event: React.MouseEvent) => {
    event.stopPropagation();
    const split = workbench.getSplit(splitId);
    if (!split) return;
    const p = split.parts.get(part.id);
    if (p) split.closePart(p).catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "hover:bg-accent flex h-7 items-center gap-1 rounded px-2 text-xs",
        isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
      )}
    >
      {getViewIcon(part.viewType)}
      <span className="truncate">{part.title || getViewTypeLabel(part.viewType)}</span>
      <button
        type="button"
        className="hover:bg-foreground/10 rounded p-0.5"
        onClick={handleClose}
      >
        <X className="size-3" />
      </button>
    </button>
  );
}

export function TabBar({ splitId, onNewTab }: TabBarProps) {
  const activePartId = useAppStore(
    (s) => s.workbench.splits.find((sp) => sp.id === splitId)?.activePartId ?? null,
  );
  const parts = useAppStoreShallow((s) => {
    const sp = s.workbench.splits.find((sp) => sp.id === splitId);
    if (!sp) return [];
    return sp.partIds
      .map((pid) => s.workbench.parts.find((p) => p.id === pid))
      .filter((p): p is PartState => p !== undefined);
  });
  const creatableTypes = workbench.creatableTypes();

  return (
    <div className="border-border bg-background/80 flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {parts.length === 0 ? (
          <span className="text-muted-foreground text-xs">No tabs</span>
        ) : (
          parts.map((part) => (
            <TabBarItem
              key={part.id}
              part={part}
              isActive={part.id === activePartId}
              splitId={splitId}
            />
          ))
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <Menu>
          <MenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 items-center gap-1 rounded px-2 text-xs">
            <Plus className="size-3.5" />
            New tab
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            {creatableTypes.map((viewType) => (
              <MenuItem key={viewType} onClick={() => onNewTab(splitId, viewType)}>
                {getViewIcon(viewType)}
                {getViewTypeLabel(viewType)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
