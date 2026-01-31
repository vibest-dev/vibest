import { useStore } from "zustand";
import { persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { createTerminalSlice, createUISlice } from "./slices";

import type { TerminalSlice, UISlice } from "./slices";

export type AppStore = UISlice & TerminalSlice;

// Vanilla store - can be used outside React
export const appStore = createStore<AppStore>()(
	persist(
		(...a) => ({
			...createUISlice(...a),
			...createTerminalSlice(...a),
		}),
		{
			name: "vibest-app",
			// Only persist user preferences, not transient UI state
			partialize: (state) => ({
				expandedRepositories: state.expandedRepositories,
				sidebarWidth: state.sidebarWidth,
			}),
		},
	),
);

// React hook with selector support
export function useAppStore<T>(selector: (state: AppStore) => T): T {
	return useStore(appStore, selector);
}
