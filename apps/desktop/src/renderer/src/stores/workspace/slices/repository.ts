import type { StateCreator } from "zustand";
import { client } from "../../../lib/client";
import type { RepositorySlice, WorkspaceStore } from "../types";

export const createRepositorySlice: StateCreator<
	WorkspaceStore,
	[],
	[],
	RepositorySlice
> = (set, get) => ({
	repositories: [],
	isLoadingRepositories: true,

	loadRepositories: async () => {
		set({ isLoadingRepositories: true, error: null });

		try {
			const { repositories, worktreesByRepository } = await client.workspace.list();
			set({
				repositories,
				worktreesByRepository,
				isLoadingRepositories: false,
			});
		} catch (error) {
			set({ isLoadingRepositories: false, error: String(error) });
		}
	},

	addRepository: async (path: string, defaultBranch: string) => {
		set({ error: null });

		try {
			await client.workspace.addRepository({ path, defaultBranch });
			// Reload to get fresh data with worktrees
			await get().loadRepositories();
		} catch (error) {
			set({ error: String(error) });
			throw error;
		}
	},

	cloneRepository: async (url: string, targetPath: string) => {
		set({ error: null });

		try {
			await client.workspace.cloneRepository({ url, targetPath });
			// Reload to get fresh data with worktrees
			await get().loadRepositories();
		} catch (error) {
			set({ error: String(error) });
			throw error;
		}
	},

	removeRepository: async (repositoryId: string) => {
		set({ error: null });

		try {
			// Pessimistic: wait for API success before updating state
			await client.workspace.removeRepository({ repositoryId });

			set((state) => {
				// Get worktree paths to clean up status cache
				const worktreePaths =
					state.worktreesByRepository[repositoryId]?.map((w) => w.path) ?? [];

				// Clean up status cache
				const newStatusCache = { ...state.statusCache };
				const newIsLoadingStatus = { ...state.isLoadingStatus };
				for (const path of worktreePaths) {
					delete newStatusCache[path];
					delete newIsLoadingStatus[path];
				}

				// Clean up worktree loading state
				const newIsLoadingWorktrees = { ...state.isLoadingWorktrees };
				delete newIsLoadingWorktrees[repositoryId];

				// Clean up worktrees
				const newWorktreesByRepository = { ...state.worktreesByRepository };
				delete newWorktreesByRepository[repositoryId];

				return {
					repositories: state.repositories.filter((r) => r.id !== repositoryId),
					worktreesByRepository: newWorktreesByRepository,
					isLoadingWorktrees: newIsLoadingWorktrees,
					selectedWorktree:
						state.selectedWorktree?.repositoryId === repositoryId
							? null
							: state.selectedWorktree,
					statusCache: newStatusCache,
					isLoadingStatus: newIsLoadingStatus,
				};
			});
		} catch (error) {
			set({ error: String(error) });
		}
	},
});
