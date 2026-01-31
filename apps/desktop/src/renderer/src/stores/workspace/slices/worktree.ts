import type { StateCreator } from "zustand";
import type { Worktree } from "../../../../../shared/types";
import { client } from "../../../lib/client";
import type { WorkspaceStore, WorktreeSlice } from "../types";

export const createWorktreeSlice: StateCreator<
	WorkspaceStore,
	[],
	[],
	WorktreeSlice
> = (set, get) => ({
	worktreesByRepository: {},
	selectedWorktree: null,
	isLoadingWorktrees: {},

	createWorktree: async (params) => {
		set({ error: null });

		try {
			const worktree = await client.workspace.createWorktree(params);

			set((state) => ({
				worktreesByRepository: {
					...state.worktreesByRepository,
					[params.repositoryId]: [
						...(state.worktreesByRepository[params.repositoryId] ?? []),
						worktree,
					],
				},
			}));

			get().loadStatus(worktree.path);
		} catch (error) {
			set({ error: String(error) });
		}
	},

	quickCreateWorktree: async (repositoryId: string) => {
		set({ error: null });

		try {
			const worktree = await client.workspace.quickCreateWorktree({
				repositoryId,
			});

			set((state) => ({
				worktreesByRepository: {
					...state.worktreesByRepository,
					[repositoryId]: [
						...(state.worktreesByRepository[repositoryId] ?? []),
						worktree,
					],
				},
			}));

			get().loadStatus(worktree.path);
		} catch (error) {
			set({ error: String(error) });
		}
	},

	removeWorktree: async (worktreeId: string, force = false) => {
		set({ error: null });

		try {
			await client.workspace.removeWorktree({ worktreeId, force });

			set((state) => {
				let removedPath: string | null = null;

				const newWorktreesByRepository: Record<string, Worktree[]> = {};
				for (const [repositoryId, worktrees] of Object.entries(
					state.worktreesByRepository,
				)) {
					const filtered = worktrees.filter((w) => {
						if (w.id === worktreeId) {
							removedPath = w.path;
							return false;
						}
						return true;
					});
					newWorktreesByRepository[repositoryId] = filtered;
				}

				const newStatusCache = { ...state.statusCache };
				const newIsLoadingStatus = { ...state.isLoadingStatus };
				if (removedPath) {
					delete newStatusCache[removedPath];
					delete newIsLoadingStatus[removedPath];
				}

				return {
					worktreesByRepository: newWorktreesByRepository,
					selectedWorktree:
						state.selectedWorktree?.id === worktreeId
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

	openWorktree: async (worktreeId: string) => {
		set({ error: null });

		try {
			await client.workspace.openWorktree({ worktreeId });
		} catch (error) {
			set({ error: String(error) });
		}
	},

	selectWorktree: (worktree: Worktree | null) => {
		set({ selectedWorktree: worktree });
	},
});
