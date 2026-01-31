import Store from "electron-store";
import { existsSync } from "node:fs";

import type { Repository, StoreSchema, StoredWorktree, Worktree } from "../../shared/types";

export class StoreService {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: "workspaces",
      cwd: "vibest-desktop",
      defaults: {
        repositories: [],
        worktrees: [],
      },
    });
  }

  // Repository operations
  getRepositories(): Repository[] {
    const repositories = this.store.get("repositories", []);
    // Migrate old repositories without defaultBranch
    return repositories.map((r) => ({
      ...r,
      defaultBranch: r.defaultBranch || "main",
    }));
  }

  getRepository(id: string): Repository | undefined {
    const repositories = this.getRepositories();
    return repositories.find((r) => r.id === id);
  }

  addRepository(repository: Repository): void {
    const repositories = this.getRepositories();
    repositories.push(repository);
    this.store.set("repositories", repositories);
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
}
