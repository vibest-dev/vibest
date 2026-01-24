import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@vibest/ui/components/avatar";
import { cn } from "@vibest/ui/lib/utils";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full items-end justify-end gap-2 py-1.5",
			from === "user" ? "is-user" : "is-assistant flex-row-reverse justify-end",
			className,
		)}
		{...props}
	/>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
	children,
	className,
	...props
}: MessageContentProps) => (
	<div
		className={cn(
			"flex flex-col gap-2 overflow-hidden text-foreground text-sm",
			"group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:rounded-lg group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:max-w-[80%]",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);

export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
	src: string;
	name?: string;
};

export const MessageAvatar = ({
	src,
	name,
	className,
	...props
}: MessageAvatarProps) => (
	<Avatar className={cn("size-8 ring-1 ring-border", className)} {...props}>
		<AvatarImage alt="" className="mt-0 mb-0" src={src} />
		<AvatarFallback>{name?.slice(0, 2) || "ME"}</AvatarFallback>
	</Avatar>
);
