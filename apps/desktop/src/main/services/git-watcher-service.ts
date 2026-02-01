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
	private refCounts = new Map<string, number>(); // path -> subscriber count

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
	 * Uses reference counting to handle multiple subscribers.
	 */
	watch(path: string, groupId?: string): void {
		const taskId = `git:diff:${path}`;
		const currentCount = this.refCounts.get(path) ?? 0;
		this.refCounts.set(path, currentCount + 1);

		// Already watching - just increment ref count
		if (this.isWatching(path)) {
			return;
		}

		this.scheduler.register({
			id: taskId,
			groupId: groupId ?? path,
			execute: async () => {
				const diffStats = await this.git.getDiffStats(path);
				// Map to event format
				const stats = {
					insertions: diffStats.totalInsertions,
					deletions: diffStats.totalDeletions,
					filesChanged: diffStats.files.length,
				};
				const currentStats = JSON.stringify(stats);
				const lastStats = this.lastStats.get(path);

				// Only publish if stats changed
				if (currentStats !== lastStats) {
					this.lastStats.set(path, currentStats);
					this.publisher.publish(`git:changes:${path}`, {
						type: "diff",
						path,
						stats,
					});
				}
			},
			interval: this.pollInterval,
			basePriority: this.basePriority,
		});
	}

	/**
	 * Stop watching a specific path.
	 * Only actually stops when all subscribers have unsubscribed.
	 */
	unwatch(path: string): void {
		const currentCount = this.refCounts.get(path) ?? 0;
		const newCount = Math.max(0, currentCount - 1);

		if (newCount > 0) {
			this.refCounts.set(path, newCount);
			return; // Still has subscribers
		}

		// No more subscribers, actually stop watching
		this.refCounts.delete(path);
		const taskId = `git:diff:${path}`;
		this.scheduler.unregister(taskId);
		this.lastStats.delete(path);
	}

	/**
	 * Stop watching all paths with a specific group ID (e.g., worktreeId).
	 */
	unwatchByGroup(groupId: string): void {
		this.scheduler.unregisterByGroup(groupId);
		// Clean up lastStats and refCounts for paths in this group
		for (const path of this.lastStats.keys()) {
			if (path.includes(groupId)) {
				this.lastStats.delete(path);
				this.refCounts.delete(path);
			}
		}
	}

	/**
	 * Check if a path is being watched.
	 */
	isWatching(path: string): boolean {
		const taskId = `git:diff:${path}`;
		return this.scheduler.has(taskId);
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
		this.refCounts.clear();
	}
}
