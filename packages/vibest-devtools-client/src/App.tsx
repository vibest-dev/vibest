import { Button } from "@vibest/ui/components/button";
import { cn } from "@vibest/ui/lib/utils";
import { BotIcon } from "lucide-react";
import { FloatingChat } from "@/components/floating-chat-panel";
import { useToolbarContext } from "@/context/toolbar";

export function Toolbar() {
	const { toolbarRef, open, setOpen } = useToolbarContext();

	return (
		<>
			<div
				ref={toolbarRef}
				className={cn(
					"fixed bottom-5 right-5 z-[2147483646] rounded-3xl flex items-center border border-border shadow-md select-none",
					"bg-white/80 backdrop-blur-lg dark:bg-gray-900/80",
				)}
			>
				<Button
					variant="ghost"
					className="size-10 rounded-full"
					aria-label={open ? "Close chat" : "Open chat"}
					onClick={() => setOpen(!open)}
				>
					<BotIcon className="size-4 rounded-full" />
				</Button>
			</div>
			<FloatingChat />
		</>
	);
}
