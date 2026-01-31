import { createStore } from "zustand/vanilla";
import { createGitStatusSlice } from "./slices/git-status";
import { createRepoSlice } from "./slices/repo";
import { createWorktreeSlice } from "./slices/worktree";
import type { WorkspaceStore } from "./types";

export const workspaceStore = createStore<WorkspaceStore>()((...args) => ({
	...createRepoSlice(...args),
	...createWorktreeSlice(...args),
	...createGitStatusSlice(...args),
	error: null,
	clearError: () => workspaceStore.setState({ error: null }),
}));
