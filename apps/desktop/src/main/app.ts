import { MemoryPublisher } from "@orpc/experimental-publisher/memory";

import type { GitChangeEvent } from "../shared/contract/git";
import type { TerminalEvent } from "../shared/contract/terminal";

import {
  GitService,
  GitWatcherService,
  StoreService,
  TaskService,
  WorktreeService,
} from "./services";
import { TerminalManager } from "./terminal";

export type AppEvents = {
  [K: `terminal:${string}`]: TerminalEvent;
  [K: `git:changes:${string}`]: GitChangeEvent;
};

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
    this.gitWatcher = new GitWatcherService(this.git, this.publisher);
    this.worktree = new WorktreeService(this.git);
    this.task = new TaskService(this.store, this.worktree, this.git);
    this.terminal = new TerminalManager(this.publisher);
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
