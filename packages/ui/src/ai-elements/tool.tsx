"use client";

import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  type CollapsibleProps,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { cn } from "@vibest/ui/lib/utils";
import { SquareMinusIcon, SquarePlusIcon } from "lucide-react";

export type ToolProps = CollapsibleProps;

export const Tool = ({ className, ...props }: ToolProps) => {
  return <Collapsible className={cn("not-prose w-full py-1", className)} lazyMount {...props} />;
};

export type ToolHeaderProps = {
  icon?: LucideIcon;
  className?: string;
  children?: ReactNode;
};

export const ToolHeader = ({ className, icon: Icon, children, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
    <div className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 overflow-hidden">
      <span className="relative">
        {Icon && (
          <Icon className="size-4 group-hover:opacity-0 group-data-[state=open]:opacity-0" />
        )}
        <div className="absolute inset-0 size-4 opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100">
          <SquarePlusIcon className="size-4 group-data-[state=open]:hidden" />
          <SquareMinusIcon className="hidden size-4 group-data-[state=open]:block" />
        </div>
      </span>
      <span className="truncate text-sm">{children}</span>
    </div>
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, children, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in text-popover-foreground outline-none",
      className,
    )}
    {...props}
  >
    <div className="border-muted mt-2 ml-[7px] space-y-2 border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
);
