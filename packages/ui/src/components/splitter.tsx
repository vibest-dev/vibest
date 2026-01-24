import { Splitter as SplitterPrimitive } from "@ark-ui/react/splitter";
import { cn } from "@vibest/ui/lib/utils";

function Splitter(props: SplitterPrimitive.RootProps) {
	return <SplitterPrimitive.Root {...props} />;
}
const SplitterContext = SplitterPrimitive.Context;

function SplitterPanel(props: SplitterPrimitive.PanelProps) {
	return <SplitterPrimitive.Panel {...props} />;
}

const SplitterProvider = SplitterPrimitive.RootProvider;

function SplitterResizeTrigger({
	className,
	...props
}: SplitterPrimitive.ResizeTriggerProps) {
	return (
		<SplitterPrimitive.ResizeTrigger
			className={cn(
				"w-0.5 bg-border transition-all duration-200 ease-in-out relative",
				"hover:bg-accent hover:shadow-lg hover:shadow-accent/50 hover:scale-x-[3] hover:z-10",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Splitter,
	SplitterContext,
	SplitterPanel,
	SplitterProvider,
	SplitterResizeTrigger,
};
