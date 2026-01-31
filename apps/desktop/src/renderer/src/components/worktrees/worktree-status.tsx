import { Skeleton } from "@vibest/ui/components/skeleton";
import {
	ArrowDown,
	ArrowUp,
	Check,
	Circle,
	FileEdit,
	FilePlus,
} from "lucide-react";
import type { GitStatus } from "../../types";

interface WorktreeStatusProps {
	status: GitStatus | undefined;
	isLoading: boolean;
}

export function WorktreeStatus({ status, isLoading }: WorktreeStatusProps) {
	if (isLoading || !status) {
		return <Skeleton className="h-4 w-24 rounded" />;
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			{status.clean ? (
				<span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
					<Check className="w-3 h-3" />
					Clean
				</span>
			) : (
				<>
					{status.staged > 0 && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
							<Circle className="w-2 h-2 fill-current" />
							{status.staged} staged
						</span>
					)}
					{status.modified > 0 && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-foreground">
							<FileEdit className="w-3 h-3" />
							{status.modified}
						</span>
					)}
					{status.untracked > 0 && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
							<FilePlus className="w-3 h-3" />
							{status.untracked}
						</span>
					)}
				</>
			)}

			{(status.ahead > 0 || status.behind > 0) && (
				<span className="text-muted-foreground/30">|</span>
			)}

			{status.ahead > 0 && (
				<span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-info-foreground tabular-nums">
					<ArrowUp className="w-3 h-3" />
					{status.ahead}
				</span>
			)}
			{status.behind > 0 && (
				<span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-warning-foreground tabular-nums">
					<ArrowDown className="w-3 h-3" />
					{status.behind}
				</span>
			)}
		</div>
	);
}
