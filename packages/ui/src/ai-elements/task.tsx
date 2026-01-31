"use client";

import type { ComponentProps, ReactElement } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { cn } from "@vibest/ui/lib/utils";
import { ChevronDownIcon, SearchIcon } from "lucide-react";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div
    className={cn(
      "bg-secondary text-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    defaultOpen={defaultOpen}
    {...props}
  />
);

export type TaskTriggerProps = Omit<ComponentProps<typeof CollapsibleTrigger>, "render"> & {
  title: string;
  render?: ReactElement;
};

export const TaskTrigger = ({ className, title, render, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger
    className={cn("group", className)}
    render={
      render ?? (
        <div className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2">
          <SearchIcon className="size-4" />
          <p className="text-sm">{title}</p>
          <ChevronDownIcon className="size-4 transition-transform group-data-[panel-open]:rotate-180" />
        </div>
      )
    }
    {...props}
  />
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      "text-popover-foreground transition-opacity outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
      className,
    )}
    {...props}
  >
    <div className="border-muted mt-4 space-y-2 border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
);
