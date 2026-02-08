import PQueue from "p-queue";

export interface PollTask {
	id: string;
	groupId?: string; // 用于批量 unregister（如 worktreeId）
	execute: () => Promise<unknown>;
	interval: number;
	nextRun: number;
	basePriority: number;
	failCount: number;
}

export interface PollingSchedulerOptions {
	concurrency?: number;
	maxRetries?: number;
	taskTimeout?: number;
	now?: () => number; // 便于测试
}

export class PollingScheduler {
	private queue: PQueue;
	private tasks = new Map<string, PollTask>();
	private timer: NodeJS.Timeout | null = null;
	private tickInterval = 1000;
	private maxBackoff = 300_000; // 5 分钟
	private maxRetries: number;
	private taskTimeout: number;
	private now: () => number;

	constructor(options?: PollingSchedulerOptions) {
		this.queue = new PQueue({ concurrency: options?.concurrency ?? 3 });
		this.maxRetries = options?.maxRetries ?? 10;
		this.taskTimeout = options?.taskTimeout ?? 5000;
		this.now = options?.now ?? Date.now;
	}

	register(task: Omit<PollTask, "nextRun" | "failCount">) {
		this.tasks.set(task.id, {
			...task,
			nextRun: this.now(),
			failCount: 0,
		});
		this.ensureRunning();
	}

	unregister(id: string) {
		this.tasks.delete(id);
		if (this.tasks.size === 0) {
			this.stop();
		}
	}

	unregisterByGroup(groupId: string) {
		for (const [id, task] of this.tasks) {
			if (task.groupId === groupId) {
				this.tasks.delete(id);
			}
		}
		if (this.tasks.size === 0) {
			this.stop();
		}
	}

	has(id: string): boolean {
		return this.tasks.has(id);
	}

	runNow(id: string) {
		const task = this.tasks.get(id);
		if (task) {
			task.nextRun = 0;
		}
	}

	runAllByGroup(groupId: string) {
		for (const task of this.tasks.values()) {
			if (task.groupId === groupId) {
				task.nextRun = 0;
			}
		}
	}

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.tickInterval);
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.queue.clear();
	}

	private ensureRunning() {
		if (this.tasks.size > 0 && !this.timer) {
			this.start();
		}
	}

	private tick() {
		const now = this.now();

		for (const task of this.tasks.values()) {
			if (task.nextRun <= now) {
				// 超过最大重试次数，跳过
				if (task.failCount >= this.maxRetries) {
					continue;
				}

				// 动态优先级：等待越久优先级越高
				const waitTime = now - task.nextRun;
				const dynamicPriority = task.basePriority + Math.floor(waitTime / 1000);

				// 先设置下次时间，防止重复入队
				task.nextRun = now + task.interval;

				this.queue.add(() => this.execute(task), { priority: dynamicPriority });
			}
		}
	}

	private async execute(task: PollTask) {
		try {
			// 超时保护
			await Promise.race([
				task.execute(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Task timeout")), this.taskTimeout),
				),
			]);
			task.failCount = 0;
		} catch {
			task.failCount++;
			const backoff = Math.min(
				task.interval * 2 ** task.failCount,
				this.maxBackoff,
			);
			task.nextRun = this.now() + backoff;
			console.warn(
				`Task ${task.id} failed (${task.failCount}x), retry in ${backoff}ms`,
			);
		}
	}
}
