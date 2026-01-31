import type { ReactNode } from "react";

interface MainContentProps {
	children: ReactNode;
}

export function MainContent({ children }: MainContentProps) {
	return (
		<main className="flex-1 overflow-y-auto p-5 bg-background">{children}</main>
	);
}
