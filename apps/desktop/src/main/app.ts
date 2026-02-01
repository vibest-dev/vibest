import { MemoryPublisher } from "@orpc/experimental-publisher/memory";
import { GitService, StoreService, WorktreeService } from "./services";
import { TerminalManager } from "./terminal";
import type { TerminalEvent } from "../shared/contract/terminal";

export type AppEvents = {
	[K: `terminal:${string}`]: TerminalEvent;
};

export type AppPublisher = MemoryPublisher<AppEvents>;

export class App {
	readonly publisher: AppPublisher = new MemoryPublisher();
	readonly store: StoreService;
	readonly git: GitService;
	readonly worktree: WorktreeService;
	readonly terminal: TerminalManager;

	constructor() {
		this.store = new StoreService();
		this.git = new GitService();
		this.worktree = new WorktreeService(this.store, this.git);
		this.terminal = new TerminalManager(this.publisher);
	}

	async start(): Promise<void> {
		// App initialization complete
	}

	async stop(): Promise<void> {
		this.terminal.dispose();
	}
}

export type AppContext = { app: App };
