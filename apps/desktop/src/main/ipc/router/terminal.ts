import { implement } from "@orpc/server";

import type { AppContext } from "../../app";

import { terminalContract } from "../../../shared/contract/terminal";

const os = implement(terminalContract).$context<AppContext>();

export const create = os.create.handler(async ({ input, context: { app } }) => {
	const { worktreeId, cwd } = input;
	const instance = app.terminal.create(worktreeId, cwd);
	return {
		id: instance.id,
		worktreeId: instance.worktreeId,
		title: instance.title,
	};
});

export const list = os.list.handler(async ({ input, context: { app } }) => {
	const { worktreeId } = input;
	const terminals = app.terminal.getTerminalsByWorktree(worktreeId);
	return terminals.map((t) => ({
		id: t.id,
		worktreeId: t.worktreeId,
		title: t.title,
	}));
});

export const write = os.write.handler(async ({ input, context: { app } }) => {
	const { terminalId, data } = input;
	app.terminal.write(terminalId, data);
});

export const resize = os.resize.handler(async ({ input, context: { app } }) => {
	const { terminalId, cols, rows } = input;
	app.terminal.resize(terminalId, cols, rows);
});

export const close = os.close.handler(async ({ input, context: { app } }) => {
	const { terminalId } = input;
	const instance = app.terminal.get(terminalId);
	if (instance) {
		const worktreeId = instance.worktreeId;
		app.terminal.close(terminalId);
		app.terminal.recalculateTitles(worktreeId);
	}
});

// Streaming subscription for terminal output
export const subscribe = os.subscribe.handler(async function* ({ input, context: { app }, signal }) {
	const { terminalId } = input;

	// Create a queue to hold events until they're yielded
	const queue: Array<{ type: "data"; data: string } | { type: "exit"; exitCode: number }> = [];
	let resolve: (() => void) | null = null;

	const unsubscribe = app.terminal.subscribe(terminalId, (event) => {
		queue.push(event);
		if (resolve) {
			resolve();
			resolve = null;
		}
	});

	try {
		while (!signal?.aborted) {
			// Wait for events if queue is empty
			if (queue.length === 0) {
				await new Promise<void>((r) => {
					resolve = r;
				});
			}

			// Yield all queued events
			while (queue.length > 0) {
				const event = queue.shift()!;
				yield event;

				// If this is an exit event, we're done
				if (event.type === "exit") {
					return;
				}
			}
		}
	} finally {
		unsubscribe();
	}
});

export const terminalRouter = os.router({
	create,
	list,
	write,
	resize,
	close,
	subscribe,
});
