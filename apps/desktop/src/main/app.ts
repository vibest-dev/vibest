import { GitService, StoreService, WorktreeService } from "./services";
import { TerminalManager } from "./terminal";

export class App {
	readonly store: StoreService;
	readonly git: GitService;
	readonly worktree: WorktreeService;
	readonly terminal: TerminalManager;

	constructor() {
		this.store = new StoreService();
		this.git = new GitService();
		this.worktree = new WorktreeService(this.store, this.git);
		this.terminal = new TerminalManager();
	}

	async start(): Promise<void> {
		console.log("[App] Started");
	}

	async stop(): Promise<void> {
		this.terminal.dispose();
		console.log("[App] Stopped");
	}
}

export type AppContext = { app: App };
