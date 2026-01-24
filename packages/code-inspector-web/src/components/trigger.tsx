import { Button } from "@vibest/ui/components/button";
import { useSelector } from "@xstate/store/react";
import { MousePointerClickIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { inspectorStore } from "../store";

export const InspectorTrigger = ({
	className,
	...props
}: ComponentProps<typeof Button>) => {
	const state = useSelector(
		inspectorStore,
		(snapshot) => snapshot.context.state,
	);
	const isIdle = state === "idle";

	return (
		<Button
			variant={isIdle ? "ghost" : "default"}
			data-state={state}
			className={className}
			{...props}
			onClick={() => {
				if (isIdle) inspectorStore.trigger.START();
				else inspectorStore.trigger.STOP();
			}}
		>
			<MousePointerClickIcon />
		</Button>
	);
};
