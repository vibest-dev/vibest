"use client";

import { cn } from "@vibest/ui/lib/utils";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

interface SplitterPanelConfig {
  id: string;
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
}

interface SplitterProps extends Omit<GroupProps, "orientation"> {
  panels?: SplitterPanelConfig[];
  defaultSize?: number[];
  direction?: "horizontal" | "vertical";
}

function Splitter({
  panels: _panels,
  defaultSize: _defaultSize,
  className,
  direction = "horizontal",
  ...props
}: SplitterProps) {
  return (
    <Group
      orientation={direction}
      className={cn("flex", direction === "vertical" ? "flex-col" : "flex-row", className)}
      {...props}
    />
  );
}

interface SplitterPanelProps extends Omit<PanelProps, "id"> {
  id?: string;
}

function SplitterPanel({ className, id, ...props }: SplitterPanelProps) {
  return <Panel id={id} className={cn("", className)} {...props} />;
}

interface SplitterResizeTriggerProps extends SeparatorProps {
  id?: string;
}

function SplitterResizeTrigger({ className, id: _id, ...props }: SplitterResizeTriggerProps) {
  return (
    <Separator
      className={cn(
        "bg-border relative w-0.5 transition-all duration-200 ease-in-out",
        "hover:bg-accent hover:shadow-accent/50 hover:z-10 hover:scale-x-[3] hover:shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

export { Splitter, SplitterPanel, SplitterResizeTrigger };
export type { SplitterProps, SplitterPanelProps, SplitterResizeTriggerProps };
