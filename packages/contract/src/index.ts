import { fsContract } from "./fs";
import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./project";

export const contract = {
  session: sessionContract,
  project: projectContract,
  fs: fsContract,
};
export type Contract = typeof contract;

export { fsContract, projectContract, sessionContract };
