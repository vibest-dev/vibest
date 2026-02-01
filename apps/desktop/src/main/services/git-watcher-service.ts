import type { AppPublisher } from "../app";
import { PollingScheduler } from "../infra/polling-scheduler";
import type { GitService } from "./git-service";

export interface GitWatcherServiceOptions {
	pollInterval?: number; // Default: 10 seconds
	basePriority?: number; // Default: 5
}

export class GitWatcherService {
	private scheduler: PollingScheduler;
	private git: GitService;
	private publisher: AppPublisher;
	private pollInterval: number;
	private basePriority: number;
	private lastStats = new Map<string, string>(); // path -> JSON stats

	constructor(
		git: GitService,
		publisher: AppPublisher,
		options?: GitWatcherServiceOptions,
	) {
		this.git = git;
		this.publisher = publisher;
		this.pollInterval = options?.pollInterval ?? 10_000;
		this.basePriority = options?.basePriority ?? 5;
		this.scheduler = new PollingScheduler({
			concurrency: 3,
			maxRetries: 10,
			taskTimeout: 5000,
		});
	}

	/**
	 * Start watching a worktree path for git diff changes.
	 * Events are published to `git:changes:${path}` channel.
	 */
	watch(path: string, groupId?: string): void {
		const taskId = `git:diff:${path}`;

		// Already watching
		if (this.isWatching(path)) {
			return;
		}

		this.scheduler.register({
			id: taskId,
			groupId: groupId ?? path,
			execute: async () => {
				const diff = await this.git.getDiff(path);
				const currentStats = JSON.stringify(diff.stats);
				const lastStats = this.lastStats.get(path);

				// Only publish if stats changed
				if (currentStats !== lastStats) {
					this.lastStats.set(path, currentStats);
					this.publisher.publish(`git:changes:${path}`, {
						type: "diff",
						path,
						stats: diff.stats,
					});
				}
			},
			interval: this.pollInterval,
			basePriority: this.basePriority,
		});
	}

	/**
	 * Stop watching a specific path.
	 */
	unwatch(path: string): void {
		const taskId = `git:diff:${path}`;
		this.scheduler.unregister(taskId);
		this.lastStats.delete(path);
	}

	/**
	 * Stop watching all paths with a specific group ID (e.g., worktreeId).
	 */
	unwatchByGroup(groupId: string): void {
		this.scheduler.unregisterByGroup(groupId);
		// Clean up lastStats for paths in this group
		for (const path of this.lastStats.keys()) {
			if (path.includes(groupId)) {
				this.lastStats.delete(path);
			}
		}
	}

	/**
	 * Check if a path is being watched.
	 */
	isWatching(path: string): boolean {
		const taskId = `git:diff:${path}`;
		// Access the scheduler's tasks map to check if task exists
		// Note: This is a simple implementation; could add a public method to scheduler
		return (this.scheduler as any).tasks?.has(taskId) ?? false;
	}

	/**
	 * Trigger immediate refresh for a specific path.
	 */
	refresh(path: string): void {
		const taskId = `git:diff:${path}`;
		this.scheduler.runNow(taskId);
	}

	/**
	 * Trigger immediate refresh for all paths in a group.
	 */
	refreshByGroup(groupId: string): void {
		this.scheduler.runAllByGroup(groupId);
	}

	/**
	 * Stop all watchers and cleanup.
	 */
	dispose(): void {
		this.scheduler.stop();
		this.lastStats.clear();
	}
}
