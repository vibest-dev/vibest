"use client";

import { Splitter as SplitterPrimitive } from "@ark-ui/react/splitter";
import { cn } from "@vibest/ui/lib/utils";

function Splitter({ className, ...props }: SplitterPrimitive.RootProps) {
  return <SplitterPrimitive.Root className={cn("flex w-full", className)} {...props} />;
}

const SplitterContext = SplitterPrimitive.Context;

function SplitterPanel(props: SplitterPrimitive.PanelProps) {
  return <SplitterPrimitive.Panel {...props} />;
}

const SplitterProvider = SplitterPrimitive.RootProvider;

function SplitterResizeTrigger({ className, ...props }: SplitterPrimitive.ResizeTriggerProps) {
  return (
    <SplitterPrimitive.ResizeTrigger
      className={cn(
        "bg-border relative w-0.5 transition-all duration-200 ease-in-out",
        "hover:bg-accent hover:shadow-accent/50 hover:z-10 hover:scale-x-[3] hover:shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

function SplitterResizeTriggerIndicator(props: SplitterPrimitive.ResizeTriggerIndicatorProps) {
  return <SplitterPrimitive.ResizeTriggerIndicator {...props} />;
}

export { useSplitter, useSplitterContext } from "@ark-ui/react/splitter";
export {
  Splitter,
  SplitterContext,
  SplitterPanel,
  SplitterProvider,
  SplitterResizeTrigger,
  SplitterResizeTriggerIndicator,
};
