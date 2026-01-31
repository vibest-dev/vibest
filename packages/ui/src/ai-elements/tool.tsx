"use client";

import type { CollapsibleRootProps } from "@base-ui/react/collapsible";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { cn } from "@vibest/ui/lib/utils";
import { SquareMinusIcon, SquarePlusIcon } from "lucide-react";

export type ToolProps = CollapsibleRootProps;

export const Tool = ({ className, ...props }: ToolProps) => {
  return <Collapsible className={cn("not-prose w-full py-1", className)} {...props} />;
};

export type ToolHeaderProps = {
  icon?: LucideIcon;
  className?: string;
  children?: ReactNode;
};

export const ToolHeader = ({ className, icon: Icon, children, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn("group", className)}
    render={
      <div className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 overflow-hidden">
        <span className="relative">
          {Icon && (
            <Icon className="size-4 group-hover:opacity-0 group-data-[panel-open]:opacity-0" />
          )}
          <div className="absolute inset-0 size-4 opacity-0 group-hover:opacity-100 group-data-[panel-open]:opacity-100">
            <SquarePlusIcon className="size-4 group-data-[panel-open]:hidden" />
            <SquareMinusIcon className="hidden size-4 group-data-[panel-open]:block" />
          </div>
        </span>
        <span className="truncate text-sm">{children}</span>
      </div>
    }
    {...props}
  />
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, children, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "text-popover-foreground transition-opacity outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
      className,
    )}
    {...props}
  >
    <div className="border-muted mt-2 ml-[7px] space-y-2 border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
);
