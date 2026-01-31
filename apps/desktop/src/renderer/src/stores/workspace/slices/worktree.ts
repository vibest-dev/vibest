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
	worktreesByRepo: {},
	selectedWorktree: null,
	isLoadingWorktrees: {},

	createWorktree: async (params) => {
		set({ error: null });

		try {
			const worktree = await client.workspace.createWorktree(params);

			set((state) => ({
				worktreesByRepo: {
					...state.worktreesByRepo,
					[params.repositoryId]: [
						...(state.worktreesByRepo[params.repositoryId] ?? []),
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
				worktreesByRepo: {
					...state.worktreesByRepo,
					[repositoryId]: [
						...(state.worktreesByRepo[repositoryId] ?? []),
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

				const newWorktreesByRepo: Record<string, Worktree[]> = {};
				for (const [repositoryId, worktrees] of Object.entries(
					state.worktreesByRepo,
				)) {
					const filtered = worktrees.filter((w) => {
						if (w.id === worktreeId) {
							removedPath = w.path;
							return false;
						}
						return true;
					});
					newWorktreesByRepo[repositoryId] = filtered;
				}

				const newStatusCache = { ...state.statusCache };
				const newIsLoadingStatus = { ...state.isLoadingStatus };
				if (removedPath) {
					delete newStatusCache[removedPath];
					delete newIsLoadingStatus[removedPath];
				}

				return {
					worktreesByRepo: newWorktreesByRepo,
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
