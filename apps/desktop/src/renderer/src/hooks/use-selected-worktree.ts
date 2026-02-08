import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { orpc } from "../lib/orpc";
import { useAppStore } from "../stores";

/**
 * Derives the selected worktree from TanStack Query server state
 * and Zustand UI state.
 *
 * This is a computed/derived state that combines:
 * - Server state: workspace data from TanStack Query via oRPC
 * - Client state: selectedWorktreeId from Zustand
 *
 * Returns null if:
 * - No worktree is selected
 * - Workspace data hasn't loaded yet
 * - Selected worktree no longer exists (was deleted)
 */
export function useSelectedWorktree() {
	const { data } = useQuery(orpc.workspace.list.queryOptions({}));
	const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);

	return useMemo(() => {
		if (!selectedWorktreeId || !data) return null;

		// Search through all worktrees to find the selected one
		for (const worktrees of Object.values(data.worktreesByRepository)) {
			const found = worktrees.find((w) => w.id === selectedWorktreeId);
			if (found) return found;
		}

		return null;
	}, [selectedWorktreeId, data]);
}
