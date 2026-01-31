import { implement } from "@orpc/server";
import { exec } from "child_process";
import { basename } from "path";
import { workspaceContract } from "../../../shared/contract/workspace";
import { pathToId, type Repository, type Worktree } from "../../../shared/types";
import type { AppContext } from "../../app";

const os = implement(workspaceContract).$context<AppContext>();

// List all repos and worktrees
export const list = os.list.handler(async ({ context: { app } }) => {
	const repositories = app.store.getRepositories();
	const worktreesByRepo: Record<string, Worktree[]> = {};

	for (const repo of repositories) {
		worktreesByRepo[repo.id] = app.store.getWorktreesByRepoId(repo.id);
	}

	return { repositories, worktreesByRepo };
});

// Repository operations
export const addRepo = os.addRepo.handler(
	async ({ input, context: { app } }) => {
		const { path, defaultBranch } = input;

		const isRepo = await app.git.isGitRepository(path);
		if (!isRepo) {
			throw new Error("Not a Git repository");
		}

		const existing = app.store.getRepositories().find((r) => r.path === path);
		if (existing) {
			throw new Error("Repository already added");
		}

		const repo: Repository = {
			id: pathToId(path),
			name: basename(path),
			path,
			defaultBranch,
		};

		app.store.addRepository(repo);
		await app.worktree.syncWorktreesWithStore(repo.id, repo.path, repo.name);

		return repo;
	},
);

export const cloneRepo = os.cloneRepo.handler(
	async ({ input, context: { app } }) => {
		const { url, targetPath, defaultBranch } = input;

		await app.git.clone(url, targetPath);

		const detectedBranch =
			defaultBranch || (await app.git.getDefaultBranch(targetPath));

		const repo: Repository = {
			id: pathToId(targetPath),
			name: basename(targetPath),
			path: targetPath,
			defaultBranch: detectedBranch,
		};

		app.store.addRepository(repo);
		await app.worktree.syncWorktreesWithStore(repo.id, repo.path, repo.name);

		return repo;
	},
);

export const removeRepo = os.removeRepo.handler(
	async ({ input, context: { app } }) => {
		const { repositoryId } = input;

		app.store.removeWorktreesByRepoId(repositoryId);
		app.store.removeRepository(repositoryId);
	},
);

export const getDefaultBranch = os.getDefaultBranch.handler(
	async ({ input, context: { app } }) => {
		const { path } = input;

		const isRepo = await app.git.isGitRepository(path);
		if (!isRepo) {
			throw new Error("Not a Git repository");
		}

		return app.git.getDefaultBranch(path);
	},
);

export const getBranches = os.getBranches.handler(
	async ({ input, context: { app } }) => {
		const { path } = input;

		const isRepo = await app.git.isGitRepository(path);
		if (!isRepo) {
			throw new Error("Not a Git repository");
		}

		return app.git.getBranches(path);
	},
);

// Worktree operations
export const createWorktree = os.createWorktree.handler(
	async ({ input, context: { app } }) => {
		const { repositoryId, branch, isNewBranch, baseBranch } = input;

		const repo = app.store.getRepository(repositoryId);
		if (!repo) {
			throw new Error("Repository not found");
		}

		const usedNames = app.store.getUsedPlaceNames(repositoryId);
		const { path: worktreePath } = app.worktree.generateWorktreePath(
			repo.name,
			usedNames,
		);

		await app.worktree.createWorktree(
			repo.path,
			worktreePath,
			branch,
			isNewBranch,
			baseBranch,
		);

		const worktree: Worktree = {
			id: pathToId(worktreePath),
			repositoryId,
			path: worktreePath,
			branch,
		};

		app.store.addWorktree(worktree);

		return worktree;
	},
);

export const quickCreateWorktree = os.quickCreateWorktree.handler(
	async ({ input, context: { app } }) => {
		const { repositoryId } = input;

		const repo = app.store.getRepository(repositoryId);
		if (!repo) {
			throw new Error("Repository not found");
		}

		try {
			const gitUsername = await app.git.getGitUserName(repo.path);
			const sanitizedUsername = gitUsername
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "");

			const usedNames = app.store.getUsedPlaceNames(repositoryId);
			const { path: worktreePath, placeName } =
				app.worktree.generateWorktreePath(repo.name, usedNames);

			const branch = `${sanitizedUsername || "user"}/${placeName}`;

			await app.worktree.createWorktree(
				repo.path,
				worktreePath,
				branch,
				true,
				repo.defaultBranch,
			);

			const worktree: Worktree = {
				id: pathToId(worktreePath),
				repositoryId,
				path: worktreePath,
				branch,
			};

			app.store.addWorktree(worktree);

			return worktree;
		} catch (error) {
			console.error("[quickCreateWorktree] Error:", error);
			throw error;
		}
	},
);

export const removeWorktree = os.removeWorktree.handler(
	async ({ input, context: { app } }) => {
		const { worktreeId, force } = input;

		const worktree = app.store.getWorktree(worktreeId);
		if (!worktree) {
			throw new Error("Worktree not found");
		}

		const repo = app.store.getRepository(worktree.repositoryId);
		if (!repo) {
			throw new Error("Repository not found");
		}

		await app.worktree.removeWorktree(repo.path, worktree.path, force);
		app.store.removeWorktree(worktreeId);
	},
);

export const openWorktree = os.openWorktree.handler(
	async ({ input, context: { app } }) => {
		const { worktreeId } = input;

		const worktree = app.store.getWorktree(worktreeId);
		if (!worktree) {
			throw new Error("Worktree not found");
		}

		return new Promise<void>((resolve, reject) => {
			exec(`code "${worktree.path}"`, (error) => {
				if (error) {
					reject(new Error(`Failed to open editor: ${error.message}`));
				} else {
					resolve();
				}
			});
		});
	},
);

export const workspaceRouter = os.router({
	list,
	addRepo,
	cloneRepo,
	removeRepo,
	getDefaultBranch,
	getBranches,
	createWorktree,
	quickCreateWorktree,
	removeWorktree,
	openWorktree,
});
