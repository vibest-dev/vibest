import { MemoryPublisher } from "@orpc/experimental-publisher/memory";
import {
  GitService,
  GitWatcherService,
  TerminalManager,
  type Publisher,
  type GitWatcherEvents,
  type TerminalEvents,
} from "@vibest/services";

import { StoreService, TaskService, WorktreeService } from "./services";

export type AppEvents = TerminalEvents & GitWatcherEvents;

export type AppPublisher = MemoryPublisher<AppEvents>;

export class App {
  readonly publisher: AppPublisher = new MemoryPublisher();
  readonly store: StoreService;
  readonly git: GitService;
  readonly gitWatcher: GitWatcherService;
  readonly worktree: WorktreeService;
  readonly task: TaskService;
  readonly terminal: TerminalManager;

  constructor() {
    this.store = new StoreService();
    this.git = new GitService();
    this.gitWatcher = new GitWatcherService(
      this.git,
      this.publisher as unknown as Publisher<GitWatcherEvents>,
    );
    this.worktree = new WorktreeService();
    this.task = new TaskService(this.store, this.worktree, this.git);
    this.terminal = new TerminalManager(
      this.publisher as unknown as Publisher<TerminalEvents>,
    );
  }

  async start(): Promise<void> {
    // App initialization complete
  }

  async stop(): Promise<void> {
    this.terminal.dispose();
    this.gitWatcher.dispose();
  }
}

export type AppContext = { app: App };
