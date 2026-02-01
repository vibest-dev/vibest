import { fsContract } from "./fs";
import { gitContract } from "./git";
import { labelContract } from "./label";
import { taskContract } from "./task";
import { terminalContract } from "./terminal";
import { workspaceContract } from "./workspace";

export const contract = {
	workspace: workspaceContract,
	git: gitContract,
	fs: fsContract,
	terminal: terminalContract,
	task: taskContract,
	label: labelContract,
};

export type Contract = typeof contract;

export { fsContract, gitContract, labelContract, taskContract, terminalContract, workspaceContract };
