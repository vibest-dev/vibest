import Store from "electron-store";
import type { Repository, StoreSchema, Worktree } from "../../shared/types";

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
		const repos = this.store.get("repositories", []);
		// Migrate old repos without defaultBranch
		return repos.map((r) => ({
			...r,
			defaultBranch: r.defaultBranch || "main",
		}));
	}

	getRepository(id: string): Repository | undefined {
		const repos = this.getRepositories();
		return repos.find((r) => r.id === id);
	}

	addRepository(repo: Repository): void {
		const repos = this.getRepositories();
		repos.push(repo);
		this.store.set("repositories", repos);
	}

	removeRepository(id: string): void {
		const repos = this.getRepositories();
		this.store.set(
			"repositories",
			repos.filter((r) => r.id !== id),
		);
	}

	// Worktree operations
	getWorktrees(): Worktree[] {
		return this.store.get("worktrees", []);
	}

	getWorktreesByRepoId(repositoryId: string): Worktree[] {
		const worktrees = this.getWorktrees();
		return worktrees.filter((w) => w.repositoryId === repositoryId);
	}

	getWorktree(id: string): Worktree | undefined {
		const worktrees = this.getWorktrees();
		return worktrees.find((w) => w.id === id);
	}

	addWorktree(worktree: Worktree): void {
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

	removeWorktreesByRepoId(repositoryId: string): void {
		const worktrees = this.getWorktrees();
		this.store.set(
			"worktrees",
			worktrees.filter((w) => w.repositoryId !== repositoryId),
		);
	}

	// Get used place names for a repository
	getUsedPlaceNames(repositoryId: string): string[] {
		const worktrees = this.getWorktreesByRepoId(repositoryId);
		return worktrees.map((w) => {
			const parts = w.path.split("/");
			return parts[parts.length - 1];
		});
	}
}
