import { useStore } from "zustand";
import { workspaceStore } from "./store";
import type { WorkspaceStore } from "./types";

// Vanilla store for use outside React
export { workspaceStore };

// React hook with selector support
export function useWorkspaceStore<T>(
	selector: (state: WorkspaceStore) => T,
): T {
	return useStore(workspaceStore, selector);
}

// Re-export types
export type * from "./types";
