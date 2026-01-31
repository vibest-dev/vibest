import { fsContract } from "./fs";
import { gitContract } from "./git";
import { terminalContract } from "./terminal";
import { workspaceContract } from "./workspace";

export const contract = {
	workspace: workspaceContract,
	git: gitContract,
	fs: fsContract,
	terminal: terminalContract,
};

export type Contract = typeof contract;

export { fsContract, gitContract, terminalContract, workspaceContract };
