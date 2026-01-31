import type { GitStatus, Repository, Worktree } from "../../../../shared/types";

export interface RepositorySlice {
	repositories: Repository[];
	isLoadingRepositories: boolean;
	loadRepositories: () => Promise<void>;
	addRepository: (path: string, defaultBranch: string) => Promise<void>;
	cloneRepository: (url: string, targetPath: string) => Promise<void>;
	removeRepository: (repositoryId: string) => Promise<void>;
}

export interface WorktreeSlice {
	worktreesByRepository: Record<string, Worktree[]>;
	selectedWorktree: Worktree | null;
	isLoadingWorktrees: Record<string, boolean>;
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
	fetchRepository: (path: string) => Promise<void>;
	pullRepository: (path: string) => Promise<void>;
}

export type WorkspaceStore = RepositorySlice &
	WorktreeSlice &
	GitStatusSlice & {
		error: string | null;
		clearError: () => void;
	};
