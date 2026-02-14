// Services
export { GitService } from "./git-service";
export { GitWatcherService } from "./git-watcher-service";
export type { GitWatcherServiceOptions } from "./git-watcher-service";

// Terminal
export { TerminalManager, HeadlessTerminal } from "./terminal";
export type { TerminalInstance, TerminalEvent, TerminalEvents, TerminalSnapshot, TerminalModes } from "./terminal";

// Types
export type { GitChangeEvent, GitWatcherEvents } from "./git-watcher-types";
export type { Publisher } from "./publisher";

// Infra
export { PollingScheduler } from "./infra/polling-scheduler";

// Re-export all types
export * from "./types";
