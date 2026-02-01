import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { createTerminalSlice, createWorkspaceSlice } from "./slices";

import type { TerminalSlice, WorkspaceSlice } from "./slices";

export type AppStore = WorkspaceSlice & TerminalSlice;

// Vanilla store - can be used outside React
export const appStore = createStore<AppStore>()((...a) => ({
	...createWorkspaceSlice(...a),
	...createTerminalSlice(...a),
}));

// React hook with selector support
export function useAppStore<T>(selector: (state: AppStore) => T): T {
	return useStore(appStore, selector);
}
