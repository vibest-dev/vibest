import { fsContract } from "./fs";
import { harnessContract } from "./harness";
import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  harness: harnessContract,
  project: projectContract,
  session: sessionContract,
  fs: fsContract,
};
export type Contract = typeof contract;

export { fsContract, harnessContract, projectContract, sessionContract };
export type { SessionEventStreamItem } from "./session";
