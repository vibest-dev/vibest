import { fsContract } from "./fs";
import { gitContract } from "./git";
import { workspaceContract } from "./workspace";

export const contract = {
  workspace: workspaceContract,
  git: gitContract,
  fs: fsContract,
};

export type Contract = typeof contract;

export { fsContract, gitContract, workspaceContract };
