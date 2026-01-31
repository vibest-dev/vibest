import type { StateCreator } from "zustand";
import { client } from "../../../lib/client";
import type { GitStatusSlice, WorkspaceStore } from "../types";

export const createGitStatusSlice: StateCreator<
	WorkspaceStore,
	[],
	[],
	GitStatusSlice
> = (set, get) => ({
	statusCache: {},
	isLoadingStatus: {},

	loadStatus: async (path: string) => {
		set((state) => ({
			isLoadingStatus: { ...state.isLoadingStatus, [path]: true },
		}));

		try {
			const status = await client.git.status({ path });
			set((state) => ({
				statusCache: { ...state.statusCache, [path]: status },
				isLoadingStatus: { ...state.isLoadingStatus, [path]: false },
			}));
		} catch (error) {
			// Silently fail for status loading, just log
			console.error("Failed to load status:", error);
			set((state) => ({
				isLoadingStatus: { ...state.isLoadingStatus, [path]: false },
			}));
		}
	},

	fetchRepository: async (path: string) => {
		set({ error: null });

		try {
			await client.git.fetch({ path });
			// Reload status after fetch
			get().loadStatus(path);
		} catch (error) {
			set({ error: String(error) });
		}
	},

	pullRepository: async (path: string) => {
		set({ error: null });

		try {
			await client.git.pull({ path });
			// Reload status after pull
			get().loadStatus(path);
		} catch (error) {
			set({ error: String(error) });
		}
	},
});
