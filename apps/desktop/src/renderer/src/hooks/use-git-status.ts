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
	const fetchRepo = useWorkspaceStore((s) => s.fetchRepo);
	const pullRepo = useWorkspaceStore((s) => s.pullRepo);

	return {
		status,
		isLoading,
		refresh: () => loadStatus(path),
		fetch: () => fetchRepo(path),
		pull: () => pullRepo(path),
	};
}
