import { useWorkspaceStore } from "../stores";
import type { GitStatus } from "../types";

export function useGitStatus(path: string): {
	status: GitStatus | undefined;
	isLoading: boolean;
	refresh: () => void;
	fetch: () => Promise<void>;
	pull: () => Promise<void>;
} {
	const status = useWorkspaceStore((s) => s.statusCache[path]);
	const isLoading = useWorkspaceStore((s) => s.isLoadingStatus[path] ?? false);
	const loadStatus = useWorkspaceStore((s) => s.loadStatus);
	const fetchRepository = useWorkspaceStore((s) => s.fetchRepository);
	const pullRepository = useWorkspaceStore((s) => s.pullRepository);

	return {
		status,
		isLoading,
		refresh: () => loadStatus(path),
		fetch: () => fetchRepository(path),
		pull: () => pullRepository(path),
	};
}
