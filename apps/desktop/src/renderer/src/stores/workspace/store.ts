import { createStore } from "zustand/vanilla";
import { createGitStatusSlice } from "./slices/git-status";
import { createRepositorySlice } from "./slices/repository";
import { createWorktreeSlice } from "./slices/worktree";
import type { WorkspaceStore } from "./types";

export const workspaceStore = createStore<WorkspaceStore>()((...args) => ({
	...createRepositorySlice(...args),
	...createWorktreeSlice(...args),
	...createGitStatusSlice(...args),
	error: null,
	clearError: () => workspaceStore.setState({ error: null }),
}));
