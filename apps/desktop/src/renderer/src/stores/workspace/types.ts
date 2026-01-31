import type { GitStatus, Repository, Worktree } from "../../../../shared/types";

export interface RepoSlice {
	repos: Repository[];
	isLoadingRepos: boolean;
	loadRepos: () => Promise<void>;
	addRepo: (path: string, defaultBranch: string) => Promise<void>;
	cloneRepo: (url: string, targetPath: string) => Promise<void>;
	removeRepo: (repositoryId: string) => Promise<void>;
}

export interface WorktreeSlice {
	worktreesByRepo: Record<string, Worktree[]>;
	selectedWorktree: Worktree | null;
	createWorktree: (params: {
		repositoryId: string;
		branch: string;
		isNewBranch: boolean;
		baseBranch?: string;
	}) => Promise<void>;
	quickCreateWorktree: (repositoryId: string) => Promise<void>;
	removeWorktree: (worktreeId: string, force?: boolean) => Promise<void>;
	openWorktree: (worktreeId: string) => Promise<void>;
	selectWorktree: (worktree: Worktree | null) => void;
}

export interface GitStatusSlice {
	statusCache: Record<string, GitStatus>;
	isLoadingStatus: Record<string, boolean>;
	loadStatus: (path: string) => Promise<void>;
	fetchRepo: (path: string) => Promise<void>;
	pullRepo: (path: string) => Promise<void>;
}

export type WorkspaceStore = RepoSlice &
	WorktreeSlice &
	GitStatusSlice & {
		error: string | null;
		clearError: () => void;
	};
