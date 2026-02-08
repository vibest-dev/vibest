import type { ReactNode } from "react";

interface MainContentProps {
	children: ReactNode;
	/** When true, removes padding for full-bleed content like terminals */
	fullBleed?: boolean;
}

export function MainContent({ children, fullBleed = false }: MainContentProps) {
	return (
		<main
			className={`bg-background flex-1 overflow-hidden ${fullBleed ? "" : "overflow-y-auto p-5"}`}
		>
			{children}
		</main>
	);
}
