import { fsContract } from "./fs";
import { projectContract } from "./project";
import { sessionContract } from "./session";

export * from "./domain";
export * from "./session-events";

export const contract = {
  project: projectContract,
  session: sessionContract,
  fs: fsContract,
};
export type Contract = typeof contract;

export { fsContract, projectContract, sessionContract };
export type { SessionEventStreamItem } from "./session";
