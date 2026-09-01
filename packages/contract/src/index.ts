import { fsContract } from "./fs";
import { gitContract } from "./git";
import { harnessContract } from "./harness";
import { projectContract } from "./project";
import { ptyContract } from "./pty";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./project";
export * from "./pty";

export const contract = {
  harness: harnessContract,
  session: sessionContract,
  project: projectContract,
  fs: fsContract,
  git: gitContract,
  pty: ptyContract,
};
export type Contract = typeof contract;

export { fsContract, gitContract, harnessContract, projectContract, ptyContract, sessionContract };
