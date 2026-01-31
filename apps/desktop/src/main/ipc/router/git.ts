import { implement } from "@orpc/server";
import { gitContract } from "../../../shared/contract";
import type { AppContext } from "../../app";

const os = implement(gitContract).$context<AppContext>();

export const getStatus = os.status.handler(
	async ({ input, context: { app } }) => {
		return app.git.getStatus(input.path);
	},
);

export const fetchGit = os.fetch.handler(
	async ({ input, context: { app } }) => {
		await app.git.fetch(input.path);
	},
);

export const pullGit = os.pull.handler(async ({ input, context: { app } }) => {
	await app.git.pull(input.path);
});

export const getBranches = os.branches.handler(
	async ({ input, context: { app } }) => {
		return app.git.getBranches(input.path);
	},
);

export const getDiff = os.diff.handler(async ({ input, context: { app } }) => {
	return app.git.getDiff(input.path, input.staged);
});

export const gitRouter = os.router({
	status: getStatus,
	fetch: fetchGit,
	pull: pullGit,
	branches: getBranches,
	diff: getDiff,
});
