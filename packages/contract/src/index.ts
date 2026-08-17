import { fsContract } from "./fs";
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
  pty: ptyContract,
};
export type Contract = typeof contract;

export { fsContract, harnessContract, projectContract, ptyContract, sessionContract };
