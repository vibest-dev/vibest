import { implement } from "@orpc/server";

import type { AppContext } from "../../app";

import { contract } from "../../../shared/contract";
import { fsRouter } from "./fs";
import { gitRouter } from "./git";
import { labelRouter } from "./label";
import { shellRouter } from "./shell";
import { taskRouter } from "./task";
import { terminalRouter } from "./terminal";
import { workspaceRouter } from "./workspace";

const os = implement(contract).$context<AppContext>();

export const router = os.router({
	workspace: workspaceRouter,
	git: gitRouter,
	fs: fsRouter,
	terminal: terminalRouter,
	task: taskRouter,
	label: labelRouter,
	shell: shellRouter,
});

export type Router = typeof router;
