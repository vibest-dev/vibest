import {
	autoUpdate,
	flip,
	offset,
	shift,
	size,
	useFloating,
} from "@floating-ui/react";
import { Badge } from "@vibest/ui/components/badge";
import { Button } from "@vibest/ui/components/button";
import { useSelector } from "@xstate/store/react";
import { Trash2Icon } from "lucide-react";
import { useEffect } from "react";
import { inspectorStore } from "../store";
import type { InspectedTarget } from "../types";

function useFloatingBadge(element: HTMLElement | null) {
	const { refs, floatingStyles } = useFloating({
		open: Boolean(element),
		strategy: "fixed",
		placement: "top-start",
		middleware: [offset(8), shift({ padding: 10 }), flip()],
		whileElementsMounted: autoUpdate,
	});

	useEffect(() => {
		if (element) {
			refs.setReference(element);
		}
	}, [refs, element]);

	return { refs, floatingStyles };
}

function useFloatingOverlay(element: HTMLElement | null) {
	const { refs, floatingStyles } = useFloating({
		open: Boolean(element),
		strategy: "fixed",
		placement: "top-start",
		middleware: [
			offset(({ rects }) => -rects.reference.height),
			size({
				apply({ elements, rects }) {
					Object.assign(elements.floating.style, {
						width: `${rects.reference.width}px`,
						height: `${rects.reference.height}px`,
					});
				},
			}),
		],
		whileElementsMounted: autoUpdate,
	});

	useEffect(() => {
		if (element) {
			refs.setReference(element);
		}
	}, [refs, element]);

	return { refs, floatingStyles };
}

function CurrentElementIndicator() {
	const currentTarget = useSelector(
		inspectorStore,
		(snapshot) => snapshot.context.currentTarget,
	);
	const currentElement = currentTarget?.element ?? null;
	const { refs: badgeRefs, floatingStyles: badgeStyles } =
		useFloatingBadge(currentElement);
	const { refs: overlayRefs, floatingStyles: overlayStyles } =
		useFloatingOverlay(currentElement);

	if (!currentTarget) return null;

	const { metadata } = currentTarget;

	return (
		<>
			<div
				ref={overlayRefs.setFloating}
				style={overlayStyles}
				className="z-[2147483645] border-2 border-blue-500 rounded-lg pointer-events-none"
			/>
			{!!metadata && (
				<div
					ref={badgeRefs.setFloating}
					style={badgeStyles}
					className="z-[2147483646] pointer-events-none"
				>
					<Badge
						variant="default"
						className="bg-blue-500 text-white border-blue-500 rounded"
					>
						{metadata.componentName}
					</Badge>
				</div>
			)}
		</>
	);
}

function InspectedTargetsIndicatorItem({
	target,
}: {
	target: InspectedTarget;
}) {
	const { refs: badgeRefs, floatingStyles: badgeStyles } = useFloatingBadge(
		target.element,
	);
	const { refs: overlayRefs, floatingStyles: overlayStyles } =
		useFloatingOverlay(target.element);

	return (
		<>
			<div
				ref={overlayRefs.setFloating}
				style={overlayStyles}
				className="z-[2147483644] border-2 rounded-xl pointer-events-none border-emerald-500"
			/>
			<div
				ref={badgeRefs.setFloating}
				style={badgeStyles}
				className="z-[2147483647] flex items-center gap-1 pointer-events-auto"
			>
				<Badge
					variant="default"
					className="bg-emerald-500 text-white border-emerald-500 rounded"
				>
					{target.metadata.componentName}
				</Badge>
				<Button
					type="button"
					onClick={(event) => {
						inspectorStore.trigger.REMOVE_INSPECTED_TARGET({ id: target.id });
						event.stopPropagation();
					}}
					title="Remove inspection"
					variant="ghost"
					size="sm"
					className="h-5 w-5 p-0 bg-red-500 hover:bg-red-600 text-white rounded transition-colors"
				>
					<Trash2Icon className="w-3 h-3" />
				</Button>
			</div>
		</>
	);
}

function InspectedTargetsIndicator() {
	const inspectedTargets = useSelector(
		inspectorStore,
		(snapshot) => snapshot.context.inspectedTargets,
	);
	if (!inspectedTargets.length) return null;

	return (
		<>
			{inspectedTargets.map((target) => (
				<InspectedTargetsIndicatorItem key={target.id} target={target} />
			))}
		</>
	);
}

export function InspectorIndicator() {
	const isIdle = useSelector(
		inspectorStore,
		(snapshot) => snapshot.context.state === "idle",
	);

	if (isIdle) return null;
	return (
		<>
			<CurrentElementIndicator />
			<InspectedTargetsIndicator />
		</>
	);
}
