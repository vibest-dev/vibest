import { Empty, EmptyDescription, EmptyTitle } from "@vibest/ui/components/empty";
import { TerminalSquare } from "lucide-react";

import type { PartState } from "../../workbench/types";

import { useAppStore, useAppStoreShallow } from "../../stores/app-store";

interface ContentRendererProps {
  splitId: string;
}

// Registry of React components by viewType
const viewComponents: Record<string, React.ComponentType<{ partId: string; isVisible: boolean }>> =
  {};

export function registerViewComponent(
  viewType: string,
  component: React.ComponentType<{ partId: string; isVisible: boolean }>,
): void {
  viewComponents[viewType] = component;
}

export function ContentRenderer({ splitId }: ContentRendererProps) {
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

  if (parts.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyTitle>No tab selected</EmptyTitle>
        <EmptyDescription>Open a tab in this split.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="relative h-full">
      {parts.map((part) => {
        const Component = viewComponents[part.viewType];
        const isVisible = part.id === activePartId;

        if (!Component) {
          if (!isVisible) return null;
          return (
            <Empty key={part.id} className="h-full">
              <TerminalSquare />
              <EmptyTitle>Unsupported tab type</EmptyTitle>
              <EmptyDescription>
                View type &quot;{part.viewType}&quot; is not registered.
              </EmptyDescription>
            </Empty>
          );
        }

        return <Component key={part.id} partId={part.id} isVisible={isVisible} />;
      })}
    </div>
  );
}
