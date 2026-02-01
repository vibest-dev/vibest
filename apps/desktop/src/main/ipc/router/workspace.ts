import { implement } from "@orpc/server";
import { execFile } from "node:child_process";
import { basename } from "node:path";

import type { AppContext } from "../../app";

import { workspaceContract } from "../../../shared/contract/workspace";
import {
  DEFAULT_LABELS,
  pathToId,
  type Repository,
  type Worktree,
} from "../../../shared/types";

const os = implement(workspaceContract).$context<AppContext>();

// List all repositories and worktrees
export const list = os.list.handler(async ({ context: { app } }) => {
  const repositories = app.store.getRepositories();
  const worktreesByRepository: Record<string, Worktree[]> = {};

  for (const repository of repositories) {
    worktreesByRepository[repository.id] = app.store.getWorktreesWithExistence(repository.id);
  }

  return { repositories, worktreesByRepository };
});

// Repository operations
export const addRepository = os.addRepository.handler(async ({ input, context: { app } }) => {
  const { path, defaultBranch } = input;

  const isRepository = await app.git.isGitRepository(path);
  if (!isRepository) {
    throw new Error("Not a Git repository");
  }

  const existing = app.store.getRepositories().find((r) => r.path === path);
  if (existing) {
    throw new Error("Repository already added");
  }

  const repository: Repository = {
    id: pathToId(path),
    name: basename(path),
    path,
    defaultBranch,
    labels: [...DEFAULT_LABELS],
  };

  app.store.addRepository(repository);

  // Return the repository with labels populated
  return app.store.getRepository(repository.id)!;
});

export const cloneRepository = os.cloneRepository.handler(async ({ input, context: { app } }) => {
  const { url, targetPath, defaultBranch } = input;

  await app.git.clone(url, targetPath);

  const detectedBranch = defaultBranch || (await app.git.getDefaultBranch(targetPath));

  const repository: Repository = {
    id: pathToId(targetPath),
    name: basename(targetPath),
    path: targetPath,
    defaultBranch: detectedBranch,
    labels: [...DEFAULT_LABELS],
  };

  app.store.addRepository(repository);

  // Return the repository with labels populated
  return app.store.getRepository(repository.id)!;
});

export const removeRepository = os.removeRepository.handler(async ({ input, context: { app } }) => {
  const { repositoryId } = input;

  app.store.removeWorktreesByRepositoryId(repositoryId);
  app.store.removeRepository(repositoryId);
});

export const getDefaultBranch = os.getDefaultBranch.handler(async ({ input, context: { app } }) => {
  const { path } = input;

  const isRepository = await app.git.isGitRepository(path);
  if (!isRepository) {
    throw new Error("Not a Git repository");
  }

  return app.git.getDefaultBranch(path);
});

export const getBranches = os.getBranches.handler(async ({ input, context: { app } }) => {
  const { path } = input;

  const isRepository = await app.git.isGitRepository(path);
  if (!isRepository) {
    throw new Error("Not a Git repository");
  }

  return app.git.getBranches(path);
});

// Worktree operations (legacy - worktrees are now created via task.create)
export const removeWorktree = os.removeWorktree.handler(async ({ input, context: { app } }) => {
  const { worktreeId, force } = input;

  const worktree = app.store.getWorktree(worktreeId);
  if (!worktree) {
    throw new Error("Worktree not found");
  }

  const repository = app.store.getRepository(worktree.repositoryId);
  if (!repository) {
    throw new Error("Repository not found");
  }

  await app.worktree.safeRemoveWorktree(repository.path, worktree.path, force);
  app.store.removeWorktree(worktreeId);
});

export const archiveWorktree = os.archiveWorktree.handler(async ({ input, context: { app } }) => {
  const { worktreeId, commitFirst } = input;

  const worktree = app.store.getWorktree(worktreeId);
  if (!worktree) {
    throw new Error("Worktree not found");
  }

  const repository = app.store.getRepository(worktree.repositoryId);
  if (!repository) {
    throw new Error("Repository not found");
  }

  try {
    await app.worktree.safeArchiveWorktree(
      repository.path,
      worktree.path,
      worktree.branch,
      commitFirst ?? false,
      app.git,
    );
    app.store.removeWorktree(worktreeId);
  } catch (error) {
    console.error("[archiveWorktree] Error:", error);
    throw error;
  }
});

export const openWorktree = os.openWorktree.handler(async ({ input, context: { app } }) => {
  const { worktreeId } = input;

  const worktree = app.store.getWorktree(worktreeId);
  if (!worktree) {
    throw new Error("Worktree not found");
  }

  return new Promise<void>((resolve, reject) => {
    execFile("code", [worktree.path], (error) => {
      if (error) {
        reject(new Error(`Failed to open editor: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
});

export const workspaceRouter = os.router({
  list,
  addRepository,
  cloneRepository,
  removeRepository,
  getDefaultBranch,
  getBranches,
  removeWorktree,
  archiveWorktree,
  openWorktree,
});
