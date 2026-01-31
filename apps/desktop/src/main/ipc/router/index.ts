import { implement } from "@orpc/server";
import { contract } from "../../../shared/contract";
import type { AppContext } from "../../app";
import { fsRouter } from "./fs";
import { gitRouter } from "./git";
import { workspaceRouter } from "./workspace";

const os = implement(contract).$context<AppContext>();

export const router = os.router({
	workspace: workspaceRouter,
	git: gitRouter,
	fs: fsRouter,
});

export type Router = typeof router;
