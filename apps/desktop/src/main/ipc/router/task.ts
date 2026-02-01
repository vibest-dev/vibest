import { implement } from "@orpc/server";
import { existsSync } from "node:fs";

import type { AppContext } from "../../app";

import { taskContract } from "../../../shared/contract/task";

const os = implement(taskContract).$context<AppContext>();

// List tasks for a repository
export const list = os.list.handler(async ({ input, context: { app } }) => {
  const { repositoryId } = input;
  return app.task.getTasksWithWorktrees(repositoryId);
});

// Get single task with worktrees
export const get = os.get.handler(async ({ input, context: { app } }) => {
  const { taskId } = input;
  const result = app.task.getTaskWithWorktrees(taskId);
  if (!result) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return result;
});

// Create task (also creates worktree)
export const create = os.create.handler(async ({ input, context: { app } }) => {
  const result = await app.task.createTask(input);
  return {
    task: result.task,
    worktree: {
      ...result.worktree,
      exists: existsSync(result.worktree.path),
    },
  };
});

// Update task metadata
export const update = os.update.handler(async ({ input, context: { app } }) => {
  const { taskId, ...updates } = input;
  app.store.updateTask(taskId, updates);
  const task = app.store.getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
});

// Delete task
export const deleteTask = os.delete.handler(async ({ input, context: { app } }) => {
  const { taskId, deleteWorktree, commitFirst } = input;
  await app.task.deleteTask(taskId, deleteWorktree, commitFirst);
});

export const taskRouter = os.router({
  list,
  get,
  create,
  update,
  delete: deleteTask,
});
