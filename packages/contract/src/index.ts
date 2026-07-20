import { fsContract } from "./fs";
import { harnessContract } from "./harness";
import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./project";

export const contract = {
  harness: harnessContract,
  session: sessionContract,
  project: projectContract,
  fs: fsContract,
};
export type Contract = typeof contract;

export { fsContract, harnessContract, projectContract, sessionContract };
