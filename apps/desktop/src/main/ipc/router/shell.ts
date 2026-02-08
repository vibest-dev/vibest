import { implement } from "@orpc/server";
import { shell } from "electron";
import { shellContract } from "../../../shared/contract";
import type { AppContext } from "../../app";

const os = implement(shellContract).$context<AppContext>();

export const openExternal = os.openExternal.handler(async ({ input }) => {
	const { url } = input;

	const parsed = new URL(url);
	const allowed = ["http:", "https:", "file:"];

	if (allowed.includes(parsed.protocol)) {
		await shell.openExternal(url);
	}
});

export const shellRouter = os.router({
	openExternal,
});
