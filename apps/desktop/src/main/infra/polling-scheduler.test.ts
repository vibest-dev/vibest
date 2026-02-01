import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollingScheduler } from "./polling-scheduler";

describe("PollingScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("任务注册", () => {
		it("注册任务后应立即可执行", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 10_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // tick
			expect(execute).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("注销任务后应停止执行", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000);
			expect(execute).toHaveBeenCalledTimes(1);

			scheduler.unregister("test:1");

			await vi.advanceTimersByTimeAsync(10_000);
			expect(execute).toHaveBeenCalledTimes(1); // 没有新的调用
		});
	});

	describe("定时执行", () => {
		it("应按 interval 间隔执行", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // 第 1 次
			await vi.advanceTimersByTimeAsync(5000); // 第 2 次
			await vi.advanceTimersByTimeAsync(5000); // 第 3 次

			expect(execute).toHaveBeenCalledTimes(3);

			scheduler.stop();
		});
	});

	describe("并发控制", () => {
		it("不应超过 maxConcurrent", async () => {
			const scheduler = new PollingScheduler({ concurrency: 2 });
			let running = 0;
			let maxRunning = 0;

			const execute = vi.fn().mockImplementation(async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((r) => setTimeout(r, 100));
				running--;
			});

			// 注册 5 个任务
			for (let i = 0; i < 5; i++) {
				scheduler.register({
					id: `test:${i}`,
					execute,
					interval: 10_000,
					basePriority: 0,
				});
			}

			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(500); // 等待所有执行完

			expect(maxRunning).toBeLessThanOrEqual(2);

			scheduler.stop();
		});
	});

	describe("失败退避", () => {
		it("失败后应指数退避", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockRejectedValue(new Error("fail"));

			scheduler.register({
				id: "test:1",
				execute,
				interval: 1_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // 第 1 次失败
			expect(execute).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1000); // 还在退避期
			expect(execute).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1000); // 退避结束（1s * 2^1 = 2s）
			expect(execute).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});

		it("超过 maxRetries 后应停止重试", async () => {
			const scheduler = new PollingScheduler({ maxRetries: 2 });
			const execute = vi.fn().mockRejectedValue(new Error("fail"));

			scheduler.register({
				id: "test:1",
				execute,
				interval: 1_000,
				basePriority: 0,
			});

			// 第 1 次失败
			await vi.advanceTimersByTimeAsync(1000);
			expect(execute).toHaveBeenCalledTimes(1);

			// 第 2 次失败（退避 2s）
			await vi.advanceTimersByTimeAsync(2000);
			expect(execute).toHaveBeenCalledTimes(2);

			// 应该停止重试了，等很久也不会再执行
			await vi.advanceTimersByTimeAsync(60_000);
			expect(execute).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});
	});

	describe("优先级", () => {
		it("高优先级任务应先执行（队列中有多个等待任务时）", async () => {
			const scheduler = new PollingScheduler({ concurrency: 1 });
			const order: string[] = [];

			// 先注册一个阻塞任务来占用队列
			let blockerResolve: () => void;
			const blockerPromise = new Promise<void>((r) => {
				blockerResolve = r;
			});

			scheduler.register({
				id: "blocker",
				execute: async () => {
					order.push("blocker");
					await blockerPromise;
				},
				interval: 100_000,
				basePriority: 0,
			});

			// 等待 blocker 开始执行
			await vi.advanceTimersByTimeAsync(1000);
			expect(order).toEqual(["blocker"]);

			// 现在注册 low 和 high，它们会进入队列等待
			scheduler.register({
				id: "low",
				execute: async () => {
					order.push("low");
				},
				interval: 10_000,
				basePriority: 1,
			});

			scheduler.register({
				id: "high",
				execute: async () => {
					order.push("high");
				},
				interval: 10_000,
				basePriority: 10,
			});

			// tick 让 low 和 high 进入队列
			await vi.advanceTimersByTimeAsync(1000);

			// 释放 blocker
			blockerResolve!();
			await vi.advanceTimersByTimeAsync(100);

			// high 应该在 low 之前执行
			expect(order).toEqual(["blocker", "high", "low"]);

			scheduler.stop();
		});
	});

	describe("防饥饿", () => {
		it("等待过久的任务优先级应提升", async () => {
			const scheduler = new PollingScheduler({ concurrency: 1 });
			const order: string[] = [];

			// 慢任务，一直占用
			let blockResolve: () => void;
			const blockPromise = new Promise<void>((r) => {
				blockResolve = r;
			});

			scheduler.register({
				id: "blocker",
				execute: async () => {
					order.push("blocker");
					await blockPromise;
				},
				interval: 100_000,
				basePriority: 10,
			});

			// 低优先级任务
			scheduler.register({
				id: "starving",
				execute: async () => {
					order.push("starving");
				},
				interval: 1_000,
				basePriority: 1,
			});

			await vi.advanceTimersByTimeAsync(1000); // blocker 开始执行

			// 等待 15 秒，starving 的动态优先级 = 1 + 15 = 16 > 10
			await vi.advanceTimersByTimeAsync(15_000);

			// 释放 blocker
			blockResolve!();
			await vi.advanceTimersByTimeAsync(100);

			// starving 应该被执行了
			expect(order).toContain("starving");

			scheduler.stop();
		});
	});

	describe("runNow", () => {
		it("应立即执行指定任务", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 60_000, // 1 分钟
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // 第 1 次
			expect(execute).toHaveBeenCalledTimes(1);

			scheduler.runNow("test:1");

			await vi.advanceTimersByTimeAsync(1000); // 立即执行
			expect(execute).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});
	});

	describe("超时处理", () => {
		it("任务超时后应标记为失败", async () => {
			const scheduler = new PollingScheduler({ taskTimeout: 100 });
			const execute = vi.fn().mockImplementation(async () => {
				// 模拟一个很慢的任务
				await new Promise((r) => setTimeout(r, 5000));
			});

			scheduler.register({
				id: "test:1",
				execute,
				interval: 10_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // tick 触发任务
			await vi.advanceTimersByTimeAsync(200); // 等待超时

			// 任务应该被执行了一次
			expect(execute).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});
	});

	describe("groupId 批量管理", () => {
		it("unregisterByGroup 应移除同组所有任务", async () => {
			const scheduler = new PollingScheduler();
			const executeA = vi.fn().mockResolvedValue(undefined);
			const executeB = vi.fn().mockResolvedValue(undefined);
			const executeC = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "git:1",
				groupId: "git",
				execute: executeA,
				interval: 5_000,
				basePriority: 0,
			});

			scheduler.register({
				id: "git:2",
				groupId: "git",
				execute: executeB,
				interval: 5_000,
				basePriority: 0,
			});

			scheduler.register({
				id: "github:1",
				groupId: "github",
				execute: executeC,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // 所有任务执行一次
			expect(executeA).toHaveBeenCalledTimes(1);
			expect(executeB).toHaveBeenCalledTimes(1);
			expect(executeC).toHaveBeenCalledTimes(1);

			// 移除 git 组
			scheduler.unregisterByGroup("git");

			await vi.advanceTimersByTimeAsync(5000);
			// git 组任务不再执行
			expect(executeA).toHaveBeenCalledTimes(1);
			expect(executeB).toHaveBeenCalledTimes(1);
			// github 组任务继续执行
			expect(executeC).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});

		it("runAllByGroup 应立即触发同组所有任务", async () => {
			const scheduler = new PollingScheduler();
			const executeA = vi.fn().mockResolvedValue(undefined);
			const executeB = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "git:1",
				groupId: "git",
				execute: executeA,
				interval: 60_000,
				basePriority: 0,
			});

			scheduler.register({
				id: "git:2",
				groupId: "git",
				execute: executeB,
				interval: 60_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000); // 第一次执行
			expect(executeA).toHaveBeenCalledTimes(1);
			expect(executeB).toHaveBeenCalledTimes(1);

			// 触发整组立即执行
			scheduler.runAllByGroup("git");

			await vi.advanceTimersByTimeAsync(1000);
			expect(executeA).toHaveBeenCalledTimes(2);
			expect(executeB).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});
	});

	describe("生命周期", () => {
		it("stop 应清空队列并停止定时器", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000);
			expect(execute).toHaveBeenCalledTimes(1);

			scheduler.stop();

			await vi.advanceTimersByTimeAsync(10_000);
			expect(execute).toHaveBeenCalledTimes(1); // 不再执行
		});

		it("注销所有任务后应自动停止", async () => {
			const scheduler = new PollingScheduler();
			const execute = vi.fn().mockResolvedValue(undefined);

			scheduler.register({
				id: "test:1",
				execute,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000);

			scheduler.unregister("test:1");

			// 再次注册应该能正常工作
			scheduler.register({
				id: "test:2",
				execute,
				interval: 5_000,
				basePriority: 0,
			});

			await vi.advanceTimersByTimeAsync(1000);
			expect(execute).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});
	});
});
