import type { GitService } from "./git-service";
import type { StoreService } from "./store-service";
import type { WorktreeService } from "./worktree-service";

import {
  generateTaskId,
  pathToId,
  type StoredWorktree,
  type Task,
  type Worktree,
} from "../../shared/types";

export class TaskService {
  constructor(
    private store: StoreService,
    private worktree: WorktreeService,
    private git: GitService,
  ) {}

  /**
   * Create task with worktree atomically.
   * Order: Create worktree first (more likely to fail), then persist task.
   * Rollback: If task persistence fails, remove the created worktree.
   */
  async createTask(input: {
    repositoryId: string;
    name: string;
    description?: string;
    labels?: string[];
    branchName?: string;
  }): Promise<{ task: Task; worktree: StoredWorktree }> {
    const repository = this.store.getRepository(input.repositoryId);
    if (!repository) {
      throw new Error(`Repository not found: ${input.repositoryId}`);
    }

    // Generate worktree path and branch name
    const usedNames = this.store.getUsedPlaceNames(input.repositoryId);
    const { path: worktreePath, placeName } = this.worktree.generateWorktreePath(
      repository.name,
      usedNames,
    );
    const branchName = input.branchName ?? placeName;

    // 1. Create worktree first (most likely to fail - git operations)
    await this.worktree.createWorktree(
      repository.path,
      worktreePath,
      branchName,
      true, // isNewBranch
      repository.defaultBranch,
    );

    const worktreeId = pathToId(worktreePath);

    try {
      // 2. Create and persist task
      const task: Task = {
        id: generateTaskId(),
        repositoryId: input.repositoryId,
        name: input.name,
        description: input.description,
        labels: input.labels ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.store.addTask(task);

      // 3. Create and link worktree to task
      const storedWorktree: StoredWorktree = {
        id: worktreeId,
        repositoryId: input.repositoryId,
        taskId: task.id,
        path: worktreePath,
        branch: branchName,
      };
      this.store.addWorktree(storedWorktree);

      return { task, worktree: storedWorktree };
    } catch (error) {
      // Rollback: remove the created worktree
      try {
        await this.worktree.safeRemoveWorktree(repository.path, worktreePath, true);
      } catch (cleanupError) {
        console.error("[TaskService] Rollback cleanup failed:", cleanupError);
      }
      throw error;
    }
  }

  /**
   * Delete task and optionally its worktree.
   * If commitFirst is true, will commit all changes before deleting.
   */
  async deleteTask(taskId: string, deleteWorktree = true, commitFirst = false): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const repository = this.store.getRepository(task.repositoryId);
    if (!repository) {
      throw new Error(`Repository not found: ${task.repositoryId}`);
    }

    // Find associated worktrees
    const worktrees = this.store
      .getWorktreesByRepositoryId(task.repositoryId)
      .filter((w) => w.taskId === taskId);

    // Always delete worktrees when deleting task (1:1 relationship)
    for (const worktree of worktrees) {
      if (deleteWorktree) {
        try {
          await this.worktree.safeArchiveWorktree(
            repository.path,
            worktree.path,
            worktree.branch,
            commitFirst,
            this.git,
          );
        } catch (archiveError) {
          console.error("[TaskService] Failed to archive worktree:", worktree.path, archiveError);
        }
      }
      this.store.removeWorktree(worktree.id);
    }

    this.store.removeTask(taskId);
  }

  /**
   * Get task with its worktree(s)
   */
  getTaskWithWorktrees(taskId: string): { task: Task; worktrees: Worktree[] } | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;

    const storedWorktrees = this.store
      .getWorktreesByRepositoryId(task.repositoryId)
      .filter((w) => w.taskId === taskId);

    const worktrees = this.store
      .getWorktreesWithExistence(task.repositoryId)
      .filter((w) => storedWorktrees.some((sw) => sw.id === w.id));

    return { task, worktrees };
  }

  /**
   * Get all tasks with their worktrees for a repository
   */
  getTasksWithWorktrees(repositoryId: string): Array<{ task: Task; worktrees: Worktree[] }> {
    const tasks = this.store.getTasksByRepository(repositoryId);
    const allWorktrees = this.store.getWorktreesWithExistence(repositoryId);

    return tasks.map((task) => ({
      task,
      worktrees: allWorktrees.filter((w) => w.taskId === task.id),
    }));
  }
}
