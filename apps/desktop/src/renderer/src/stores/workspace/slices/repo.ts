import type { StateCreator } from "zustand";
import { client } from "../../../lib/client";
import type { RepoSlice, WorkspaceStore } from "../types";

export const createRepoSlice: StateCreator<
	WorkspaceStore,
	[],
	[],
	RepoSlice
> = (set, get) => ({
	repos: [],
	isLoadingRepos: true,

	loadRepos: async () => {
		set({ isLoadingRepos: true, error: null });

		try {
			const { repositories, worktreesByRepo } = await client.workspace.list();
			set({ repos: repositories, worktreesByRepo, isLoadingRepos: false });
		} catch (error) {
			set({ isLoadingRepos: false, error: String(error) });
		}
	},

	addRepo: async (path: string, defaultBranch: string) => {
		set({ error: null });

		try {
			const repo = await client.workspace.addRepo({ path, defaultBranch });
			// Reload to get fresh data with worktrees
			await get().loadRepos();
			return repo;
		} catch (error) {
			set({ error: String(error) });
			throw error;
		}
	},

	cloneRepo: async (url: string, targetPath: string) => {
		set({ error: null });

		try {
			const repo = await client.workspace.cloneRepo({ url, targetPath });
			// Reload to get fresh data with worktrees
			await get().loadRepos();
			return repo;
		} catch (error) {
			set({ error: String(error) });
			throw error;
		}
	},

	removeRepo: async (repositoryId: string) => {
		set({ error: null });

		try {
			// Pessimistic: wait for API success before updating state
			await client.workspace.removeRepo({ repositoryId });

			set((state) => {
				// Get worktree paths to clean up status cache
				const worktreePaths =
					state.worktreesByRepo[repositoryId]?.map((w) => w.path) ?? [];

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
				const newWorktreesByRepo = { ...state.worktreesByRepo };
				delete newWorktreesByRepo[repositoryId];

				return {
					repos: state.repos.filter((r) => r.id !== repositoryId),
					worktreesByRepo: newWorktreesByRepo,
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
