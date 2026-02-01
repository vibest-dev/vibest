import Store from "electron-store";
import { existsSync } from "node:fs";

import {
  DEFAULT_LABELS,
  type Label,
  type Repository,
  type StoreSchema,
  type StoredWorktree,
  type Task,
  type Worktree,
} from "../../shared/types";

export class StoreService {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: "workspaces",
      cwd: "vibest-desktop",
      defaults: {
        repositories: [],
        tasks: [],
        worktrees: [],
      },
    });
  }

  // Repository operations
  getRepositories(): Repository[] {
    const repositories = this.store.get("repositories", []);
    // Migrate old repositories without defaultBranch or labels
    return repositories.map((r) => ({
      ...r,
      defaultBranch: r.defaultBranch || "main",
      labels: r.labels?.length ? r.labels : [...DEFAULT_LABELS],
    }));
  }

  getRepository(id: string): Repository | undefined {
    const repositories = this.getRepositories();
    return repositories.find((r) => r.id === id);
  }

  addRepository(repository: Repository): void {
    const repositories = this.getRepositories();
    // Add default labels if not provided
    const repoWithLabels = {
      ...repository,
      labels: repository.labels?.length ? repository.labels : [...DEFAULT_LABELS],
    };
    repositories.push(repoWithLabels);
    this.store.set("repositories", repositories);
  }

  updateRepository(id: string, updates: Partial<Omit<Repository, "id">>): void {
    const repositories = this.getRepositories();
    const index = repositories.findIndex((r) => r.id === id);
    if (index !== -1) {
      repositories[index] = { ...repositories[index], ...updates };
      this.store.set("repositories", repositories);
    }
  }

  removeRepository(id: string): void {
    const repositories = this.getRepositories();
    this.store.set(
      "repositories",
      repositories.filter((r) => r.id !== id),
    );
  }

  // Worktree operations
  getWorktrees(): StoredWorktree[] {
    return this.store.get("worktrees", []);
  }

  getWorktreesByRepositoryId(repositoryId: string): StoredWorktree[] {
    const worktrees = this.getWorktrees();
    return worktrees.filter((w) => w.repositoryId === repositoryId);
  }

  getWorktreesWithExistence(repositoryId: string): Worktree[] {
    const worktrees = this.getWorktreesByRepositoryId(repositoryId);
    return worktrees.map((w) => ({
      ...w,
      exists: existsSync(w.path),
    }));
  }

  getWorktree(id: string): StoredWorktree | undefined {
    const worktrees = this.getWorktrees();
    return worktrees.find((w) => w.id === id);
  }

  addWorktree(worktree: StoredWorktree): void {
    const worktrees = this.getWorktrees();
    worktrees.push(worktree);
    this.store.set("worktrees", worktrees);
  }

  removeWorktree(id: string): void {
    const worktrees = this.getWorktrees();
    this.store.set(
      "worktrees",
      worktrees.filter((w) => w.id !== id),
    );
  }

  updateWorktree(id: string, updates: Partial<Omit<StoredWorktree, "id">>): void {
    const worktrees = this.getWorktrees();
    const index = worktrees.findIndex((w) => w.id === id);
    if (index !== -1) {
      worktrees[index] = { ...worktrees[index], ...updates };
      this.store.set("worktrees", worktrees);
    }
  }

  removeWorktreesByRepositoryId(repositoryId: string): void {
    const worktrees = this.getWorktrees();
    this.store.set(
      "worktrees",
      worktrees.filter((w) => w.repositoryId !== repositoryId),
    );
  }

  // Get used place names for a repository
  getUsedPlaceNames(repositoryId: string): string[] {
    const worktrees = this.getWorktreesByRepositoryId(repositoryId);
    return worktrees.map((w) => {
      const parts = w.path.split("/");
      return parts[parts.length - 1];
    });
  }

  // Task operations
  getTasks(): Task[] {
    return this.store.get("tasks", []);
  }

  getTasksByRepository(repositoryId: string): Task[] {
    return this.getTasks().filter((t) => t.repositoryId === repositoryId);
  }

  getTask(id: string): Task | undefined {
    return this.getTasks().find((t) => t.id === id);
  }

  addTask(task: Task): void {
    const tasks = this.getTasks();
    tasks.push(task);
    this.store.set("tasks", tasks);
  }

  updateTask(id: string, updates: Partial<Omit<Task, "id" | "repositoryId" | "createdAt">>): void {
    const tasks = this.getTasks();
    const index = tasks.findIndex((t) => t.id === id);
    if (index !== -1) {
      tasks[index] = { ...tasks[index], ...updates, updatedAt: Date.now() };
      this.store.set("tasks", tasks);
    }
  }

  removeTask(id: string): void {
    const tasks = this.getTasks();
    this.store.set(
      "tasks",
      tasks.filter((t) => t.id !== id),
    );
  }

  removeTasksByRepositoryId(repositoryId: string): void {
    const tasks = this.getTasks();
    this.store.set(
      "tasks",
      tasks.filter((t) => t.repositoryId !== repositoryId),
    );
  }

  // Label operations (on Repository)
  getLabels(repositoryId: string): Label[] {
    const repo = this.getRepository(repositoryId);
    return repo?.labels ?? [];
  }

  addLabel(repositoryId: string, label: Label): void {
    const repo = this.getRepository(repositoryId);
    if (!repo) return;

    const existing = repo.labels?.find((l) => l.id === label.id);
    if (existing) {
      throw new Error(`Label with id "${label.id}" already exists`);
    }

    const labels = [...(repo.labels ?? []), label];
    this.updateRepository(repositoryId, { labels });
  }

  updateLabel(repositoryId: string, labelId: string, updates: Partial<Omit<Label, "id">>): void {
    const repo = this.getRepository(repositoryId);
    if (!repo) return;

    const labels = (repo.labels ?? []).map((l) => (l.id === labelId ? { ...l, ...updates } : l));
    this.updateRepository(repositoryId, { labels });
  }

  removeLabel(repositoryId: string, labelId: string, options?: { force?: boolean }): number {
    const repo = this.getRepository(repositoryId);
    if (!repo) return 0;

    // Check if label is in use
    const tasksUsingLabel = this.getTasksByRepository(repositoryId).filter((t) =>
      t.labels.includes(labelId),
    );

    if (tasksUsingLabel.length > 0 && !options?.force) {
      throw new Error(`Label is used by ${tasksUsingLabel.length} tasks`);
    }

    // Remove label from all tasks if force
    if (options?.force) {
      for (const task of tasksUsingLabel) {
        this.updateTask(task.id, {
          labels: task.labels.filter((l) => l !== labelId),
        });
      }
    }

    // Remove label from repository
    const labels = (repo.labels ?? []).filter((l) => l.id !== labelId);
    this.updateRepository(repositoryId, { labels });

    return tasksUsingLabel.length;
  }
}
