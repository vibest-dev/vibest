import { GitService, StoreService, WorktreeService } from "./services";

export class App {
	readonly store: StoreService;
	readonly git: GitService;
	readonly worktree: WorktreeService;

	constructor() {
		this.store = new StoreService();
		this.git = new GitService();
		this.worktree = new WorktreeService(this.store, this.git);
	}

	async start(): Promise<void> {
		// Initialization logic if needed
		console.log("[App] Started");
	}

	async stop(): Promise<void> {
		// Cleanup logic if needed
		console.log("[App] Stopped");
	}
}

export type AppContext = { app: App };
