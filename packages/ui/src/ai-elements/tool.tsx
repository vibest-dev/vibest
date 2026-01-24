"use client";

import {
	Collapsible,
	CollapsibleContent,
	type CollapsibleProps,
	CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { cn } from "@vibest/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { SquareMinusIcon, SquarePlusIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type ToolProps = CollapsibleProps;

export const Tool = ({ className, ...props }: ToolProps) => {
	return (
		<Collapsible
			className={cn("not-prose w-full py-1", className)}
			lazyMount
			{...props}
		/>
	);
};

export type ToolHeaderProps = {
	icon?: LucideIcon;
	className?: string;
	children?: ReactNode;
};

export const ToolHeader = ({
	className,
	icon: Icon,
	children,
	...props
}: ToolHeaderProps) => (
	<CollapsibleTrigger asChild className={cn("group", className)} {...props}>
		<div className="flex items-center gap-2 w-full cursor-pointer text-muted-foreground hover:text-foreground overflow-hidden">
			<span className="relative">
				{Icon && (
					<Icon className="size-4 group-data-[state=open]:opacity-0 group-hover:opacity-0" />
				)}
				<div className="size-4 absolute inset-0 opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100">
					<SquarePlusIcon className="size-4 group-data-[state=open]:hidden" />
					<SquareMinusIcon className="size-4 hidden group-data-[state=open]:block" />
				</div>
			</span>
			<span className="truncate text-sm">{children}</span>
		</div>
	</CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({
	className,
	children,
	...props
}: ToolContentProps) => (
	<CollapsibleContent
		className={cn(
			"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in text-popover-foreground",
			className,
		)}
		{...props}
	>
		<div className="mt-2 ml-[7px] space-y-2 border-muted border-l-2 pl-4">
			{children}
		</div>
	</CollapsibleContent>
);
