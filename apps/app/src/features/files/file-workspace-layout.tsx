import { Button } from "@vibest/ui/components/button";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "@vibest/ui/components/sheet";
import { useIsMobile } from "@vibest/ui/hooks/use-media-query";
import { FilesIcon } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

const MIN_SPLIT_WIDTH = 24 * 16 + 6;

export function FileWorkspaceLayout({
  preview,
  tree,
  treeLabel,
}: {
  preview: ReactNode;
  tree: ReactNode;
  treeLabel: string;
}) {
  const isMobile = useIsMobile();
  const [isNarrow, setIsNarrow] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const updateWidth = (width: number): void => {
      setIsNarrow(width < MIN_SPLIT_WIDTH);
    };
    updateWidth(container.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) updateWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const useDrawer = isMobile || isNarrow;

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {useDrawer ? (
        <>
          {preview}
          <Button
            aria-controls={drawerId}
            aria-expanded={treeOpen}
            aria-label={`Open file tree for ${treeLabel}`}
            className="absolute end-11 top-1.5 z-10"
            onClick={() => setTreeOpen(true)}
            size="icon-xs"
            variant="ghost"
          >
            <FilesIcon className="size-3.5" />
          </Button>
          <Sheet onOpenChange={setTreeOpen} open={treeOpen}>
            <SheetPopup className="w-[min(90vw,24rem)]" id={drawerId} side="right">
              <SheetHeader className="border-b p-3">
                <SheetTitle className="text-base">Project files</SheetTitle>
              </SheetHeader>
              <div className="flex min-h-0 flex-1">{tree}</div>
            </SheetPopup>
          </Sheet>
        </>
      ) : (
        <Group
          className="flex min-h-0 flex-1"
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 44, fine: 12 }}
        >
          <Panel
            className="flex min-w-0 flex-col overflow-hidden"
            defaultSize="60%"
            minSize="12rem"
          >
            {preview}
          </Panel>
          <Separator
            aria-label="Resize file tree"
            className="after:bg-border hover:after:bg-foreground/30 data-[separator=active]:after:bg-primary relative w-1.5 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 data-[separator=active]:after:w-0.5"
          />
          <Panel
            className="flex min-w-0 flex-col overflow-hidden"
            defaultSize="40%"
            maxSize="50%"
            minSize="12rem"
          >
            {tree}
          </Panel>
        </Group>
      )}
    </div>
  );
}
